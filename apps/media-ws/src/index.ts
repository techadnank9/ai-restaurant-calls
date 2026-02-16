import dotenv from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import { Redis } from 'ioredis';
import { WebSocketServer } from 'ws';

dotenv.config({ path: '../../.env' });
dotenv.config();

const WS_PORT = Number(process.env.PORT ?? process.env.WS_PORT ?? 8081);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY ?? '';
const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1';
const NVIDIA_ASR_URL = process.env.NVIDIA_ASR_URL ?? '';
const NVIDIA_ASR_MODEL =
  process.env.NVIDIA_ASR_MODEL ?? 'nvidia/parakeet-1.1b-rnnt-multilingual-asr';
const APP_BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:8080';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY ?? '';

const redis = new Redis(REDIS_URL);
redis.on('error', (error) => {
  console.error('redis connection error', error.message);
});
const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

type SessionState = {
  callSid: string;
  streamSid?: string;
  accountSid?: string;
  restaurantId?: string;
  calledNumber?: string;
  mediaFrames: number;
  startedAt: string;
  stoppedAt?: string;
  status: 'active' | 'stopped';
};

type StreamBuffers = {
  callSid: string;
  fullPcm16: Buffer[];
  utterancePcm16: Buffer[];
  silenceFrames: number;
  voiceFrames: number;
  processing: Promise<void>;
};

const streamBuffers = new Map<string, StreamBuffers>();

async function saveSession(callSid: string, state: SessionState) {
  await redis.set(`call:${callSid}`, JSON.stringify(state), 'EX', 60 * 60 * 2);
}

function mulawToPcm16Sample(muLawByte: number) {
  const MULAW_BIAS = 0x84;
  const mu = (~muLawByte) & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  const sample = ((mantissa << 4) + 0x08) << exponent;
  const pcm = sign ? MULAW_BIAS - sample : sample - MULAW_BIAS;
  return Math.max(-32768, Math.min(32767, pcm));
}

function decodeMulawPayloadToPcm(payloadB64: string) {
  const muLaw = Buffer.from(payloadB64, 'base64');
  const pcm = Buffer.alloc(muLaw.length * 2);
  for (let i = 0; i < muLaw.length; i += 1) {
    pcm.writeInt16LE(mulawToPcm16Sample(muLaw[i]), i * 2);
  }
  return pcm;
}

function frameRms(chunk: Buffer) {
  const samples = chunk.length / 2;
  if (!samples) return 0;
  let sumSquares = 0;
  for (let i = 0; i < chunk.length; i += 2) {
    const s = chunk.readInt16LE(i);
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / samples);
}

function pcmToWav(pcm16: Buffer, sampleRate = 8000) {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm16.length;
  const chunkSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(chunkSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm16]);
}

async function transcribeWithParakeet(callSid: string, pcm16Chunks: Buffer[]) {
  if (!NVIDIA_API_KEY) {
    console.warn(`[asr][${callSid}] NVIDIA_API_KEY missing; transcription skipped`);
    return '';
  }

  const pcm = Buffer.concat(pcm16Chunks);
  if (pcm.length < 1600) return '';

  const wav = pcmToWav(pcm, 8000);
  const endpoints: string[] = [];
  if (NVIDIA_ASR_URL) {
    endpoints.push(NVIDIA_ASR_URL);
  } else {
    const trimmed = NVIDIA_BASE_URL.replace(/\/+$/, '');
    if (trimmed.endsWith('/v1')) {
      endpoints.push(`${trimmed}/audio/transcriptions`);
    } else {
      endpoints.push(`${trimmed}/v1/audio/transcriptions`);
      endpoints.push(`${trimmed}/audio/transcriptions`);
    }
  }

  for (const endpoint of endpoints) {
    const form = new FormData();
    form.append('model', NVIDIA_ASR_MODEL);
    form.append('file', new Blob([wav], { type: 'audio/wav' }), `${callSid}.wav`);
    form.append('language', 'en');

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NVIDIA_API_KEY}`
      },
      body: form
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(
        `[asr][${callSid}] ASR HTTP ${response.status} endpoint=${endpoint} body=${body.slice(0, 240)}`
      );
      continue;
    }

    const json = (await response.json()) as { text?: string };
    return typeof json.text === 'string' ? json.text.trim() : '';
  }

  return '';
}

async function postTranscriptToApi(callSid: string, transcript: string) {
  if (!transcript) return;
  const endpoint = new URL('/twilio/realtime-turn', APP_BASE_URL).toString();
  await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(INTERNAL_API_KEY ? { 'x-internal-api-key': INTERNAL_API_KEY } : {})
    },
    body: JSON.stringify({ callSid, transcript })
  });
}

async function flushUtterance(callSid: string, force = false) {
  const buffers = streamBuffers.get(callSid);
  if (!buffers) return;
  if (!force && (buffers.voiceFrames < 20 || buffers.utterancePcm16.length === 0)) return;

  const utterance = buffers.utterancePcm16;
  buffers.utterancePcm16 = [];
  buffers.silenceFrames = 0;
  buffers.voiceFrames = 0;

  buffers.processing = buffers.processing.then(async () => {
    try {
      const transcript = await transcribeWithParakeet(callSid, utterance);
      if (!transcript) return;
      await postTranscriptToApi(callSid, transcript);
      console.log(`[asr][${callSid}] turn_transcript=${transcript}`);
    } catch (error) {
      console.error(`[asr][${callSid}] turn transcription error`, error);
    }
  });
}

wss.on('connection', (ws) => {
  let callSid = '';

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        event: 'connected' | 'start' | 'media' | 'stop';
        sequenceNumber?: string;
        start?: {
          accountSid?: string;
          callSid?: string;
          streamSid?: string;
          customParameters?: Record<string, string>;
        };
        media?: { track: string; payload: string };
        stop?: { accountSid?: string; callSid?: string; streamSid?: string };
      };

      if (msg.event === 'start' && msg.start?.callSid) {
        callSid = msg.start.callSid;
        streamBuffers.set(callSid, {
          callSid,
          fullPcm16: [],
          utterancePcm16: [],
          silenceFrames: 0,
          voiceFrames: 0,
          processing: Promise.resolve()
        });
        const state: SessionState = {
          callSid,
          streamSid: msg.start.streamSid,
          accountSid: msg.start.accountSid,
          restaurantId: msg.start.customParameters?.restaurant_id,
          calledNumber: msg.start.customParameters?.called_number,
          mediaFrames: 0,
          startedAt: new Date().toISOString(),
          status: 'active'
        };
        await saveSession(callSid, state);
      }

      if (msg.event === 'media' && callSid) {
        if (msg.media?.payload) {
          const pcmChunk = decodeMulawPayloadToPcm(msg.media.payload);
          const buffers = streamBuffers.get(callSid);
          if (buffers) {
            buffers.fullPcm16.push(pcmChunk);
            const rms = frameRms(pcmChunk);
            const isVoice = rms > 700;
            if (isVoice) {
              buffers.voiceFrames += 1;
              buffers.silenceFrames = 0;
              buffers.utterancePcm16.push(pcmChunk);
            } else if (buffers.voiceFrames > 0) {
              buffers.silenceFrames += 1;
              buffers.utterancePcm16.push(pcmChunk);
              if (buffers.silenceFrames >= 25) {
                await flushUtterance(callSid);
              }
            }
            if (buffers.voiceFrames > 0 && buffers.utterancePcm16.length >= 500) {
              await flushUtterance(callSid, true);
            }
          }
        }
        const rawState = await redis.get(`call:${callSid}`);
        if (!rawState) return;
        const state = JSON.parse(rawState) as SessionState;
        state.mediaFrames += 1;
        await saveSession(callSid, state);
      }

      if (msg.event === 'stop' && (msg.stop?.callSid || callSid)) {
        const id = msg.stop?.callSid ?? callSid;
        const rawState = await redis.get(`call:${id}`);
        if (rawState) {
          const state = JSON.parse(rawState) as SessionState;
          state.status = 'stopped';
          state.stoppedAt = new Date().toISOString();
          await saveSession(id, state);
        }
        try {
          const buffers = streamBuffers.get(id);
          await flushUtterance(id, true);
          await buffers?.processing;
          const transcript = await transcribeWithParakeet(id, buffers?.fullPcm16 ?? []);
          if (transcript) {
            const endpoint = new URL('/twilio/media-transcript', APP_BASE_URL).toString();
            await fetch(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(INTERNAL_API_KEY ? { 'x-internal-api-key': INTERNAL_API_KEY } : {})
              },
              body: JSON.stringify({ callSid: id, transcript })
            });
            console.log(`[asr][${id}] full_transcript=${transcript}`);
          } else {
            console.log(`[asr][${id}] empty transcript`);
          }
        } catch (error) {
          console.error(`[asr][${id}] transcription error`, error);
        } finally {
          streamBuffers.delete(id);
        }
      }
    } catch (error) {
      console.error('media parse error', error);
    }
  });
});

server.listen(WS_PORT, () => {
  console.log(`media-ws listening on :${WS_PORT}`);
});
