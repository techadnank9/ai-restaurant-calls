import dotenv from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import { Redis } from 'ioredis';
import WebSocket, { WebSocketServer } from 'ws';

dotenv.config({ path: '../../.env' });
dotenv.config();

const WS_PORT = Number(process.env.PORT ?? process.env.WS_PORT ?? 8081);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const APP_BASE_URL = process.env.APP_BASE_URL ?? 'http://localhost:8080';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY ?? '';
const REALTIME_DEEPGRAM_ENABLED =
  (process.env.REALTIME_DEEPGRAM_ENABLED ?? 'true').toLowerCase() === 'true';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY ?? '';
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL ?? 'nova-3';
const DEEPGRAM_LANGUAGE = process.env.DEEPGRAM_LANGUAGE ?? 'en';
const DEEPGRAM_SMART_FORMAT =
  (process.env.DEEPGRAM_SMART_FORMAT ?? 'true').toLowerCase() === 'true';
const DEEPGRAM_TTS_MODEL = process.env.DEEPGRAM_TTS_MODEL ?? 'aura-2-thalia-en';

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

type RealtimeTurnResponse = {
  assistant_reply?: string;
  intent?: 'order' | 'reservation' | 'unknown';
  awaiting_confirmation?: boolean;
  should_end_call?: boolean;
};

type LiveSession = {
  callSid: string;
  streamSid: string;
  twilioWs: WebSocket;
  deepgramWs?: WebSocket;
  segmentSeq: number;
  lastFinalTranscript: string;
  playbackToken: number;
  ttsPlaying: boolean;
  ended: boolean;
};

const sessions = new Map<string, LiveSession>();

async function saveSession(callSid: string, state: SessionState) {
  await redis.set(`call:${callSid}`, JSON.stringify(state), 'EX', 60 * 60 * 2);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function rmsFromMulawPayload(payloadB64: string) {
  const muLaw = Buffer.from(payloadB64, 'base64');
  if (!muLaw.length) return 0;
  let sumSquares = 0;
  for (let i = 0; i < muLaw.length; i += 1) {
    const s = mulawToPcm16Sample(muLaw[i]);
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / muLaw.length);
}

function buildDeepgramUrl() {
  const url = new URL('wss://api.deepgram.com/v1/listen');
  url.searchParams.set('encoding', 'mulaw');
  url.searchParams.set('sample_rate', '8000');
  url.searchParams.set('channels', '1');
  url.searchParams.set('model', DEEPGRAM_MODEL);
  url.searchParams.set('language', DEEPGRAM_LANGUAGE);
  url.searchParams.set('smart_format', String(DEEPGRAM_SMART_FORMAT));
  url.searchParams.set('interim_results', 'true');
  url.searchParams.set('endpointing', '300');
  url.searchParams.set('punctuate', 'true');
  return url.toString();
}

function clearTwilioPlayback(session: LiveSession) {
  if (session.twilioWs.readyState !== WebSocket.OPEN) return;
  session.twilioWs.send(
    JSON.stringify({
      event: 'clear',
      streamSid: session.streamSid
    })
  );
}

async function callRealtimeTurn(
  callSid: string,
  transcript: string,
  isFinal: boolean,
  segmentId: string
): Promise<RealtimeTurnResponse> {
  const endpoint = new URL('/twilio/realtime-turn', APP_BASE_URL).toString();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(INTERNAL_API_KEY ? { 'x-internal-api-key': INTERNAL_API_KEY } : {})
    },
    body: JSON.stringify({
      callSid,
      transcript,
      is_final: isFinal,
      segment_id: segmentId
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`realtime-turn failed ${response.status}: ${body}`);
  }
  return (await response.json()) as RealtimeTurnResponse;
}

async function synthesizeDeepgramTts(text: string) {
  if (!DEEPGRAM_API_KEY) return Buffer.alloc(0);
  const endpoint = new URL('https://api.deepgram.com/v1/speak');
  endpoint.searchParams.set('model', DEEPGRAM_TTS_MODEL);
  endpoint.searchParams.set('encoding', 'mulaw');
  endpoint.searchParams.set('sample_rate', '8000');
  endpoint.searchParams.set('container', 'none');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Token ${DEEPGRAM_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`deepgram tts failed ${response.status}: ${body}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  return buf;
}

async function playTwilioUlaw(session: LiveSession, audio: Buffer) {
  if (!audio.length) return;
  session.playbackToken += 1;
  const token = session.playbackToken;
  session.ttsPlaying = true;

  const frameSize = 160; // 20ms at 8k ulaw mono
  for (let i = 0; i < audio.length; i += frameSize) {
    if (session.ended || token !== session.playbackToken) {
      session.ttsPlaying = false;
      return;
    }
    const chunk = audio.subarray(i, Math.min(i + frameSize, audio.length));
    if (session.twilioWs.readyState !== WebSocket.OPEN) {
      session.ttsPlaying = false;
      return;
    }
    session.twilioWs.send(
      JSON.stringify({
        event: 'media',
        streamSid: session.streamSid,
        media: {
          payload: chunk.toString('base64')
        }
      })
    );
    await sleep(20);
  }

  session.ttsPlaying = false;
}

async function handleFinalTranscript(session: LiveSession, transcript: string) {
  const normalized = transcript.trim();
  if (!normalized) return;
  if (normalized.toLowerCase() === session.lastFinalTranscript.toLowerCase()) return;
  session.lastFinalTranscript = normalized;

  const segmentId = `${session.callSid}-${++session.segmentSeq}`;
  console.log(`[deepgram][${session.callSid}] final=${normalized}`);

  try {
    const turn = await callRealtimeTurn(session.callSid, normalized, true, segmentId);
    const reply = (turn.assistant_reply ?? '').trim();
    if (!reply) return;
    console.log(`[turn][${session.callSid}] reply=${reply}`);
    const audio = await synthesizeDeepgramTts(reply);
    await playTwilioUlaw(session, audio);
  } catch (error) {
    console.error(`[turn][${session.callSid}] realtime handling error`, error);
  }
}

function openDeepgramForSession(session: LiveSession) {
  if (!REALTIME_DEEPGRAM_ENABLED || !DEEPGRAM_API_KEY) return;
  const dg = new WebSocket(buildDeepgramUrl(), {
    headers: {
      Authorization: `Token ${DEEPGRAM_API_KEY}`
    }
  });
  session.deepgramWs = dg;

  dg.on('open', () => {
    console.log(`[deepgram][${session.callSid}] connected`);
  });

  dg.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      const channel = (msg.channel ?? {}) as Record<string, unknown>;
      const alternatives = Array.isArray(channel.alternatives)
        ? (channel.alternatives as Record<string, unknown>[])
        : [];
      const transcript = String(alternatives[0]?.transcript ?? '').trim();
      const isFinal = Boolean(msg.is_final || msg.speech_final);

      if (transcript && !isFinal) {
        console.log(`[deepgram][${session.callSid}] partial=${transcript}`);
      }
      if (transcript && isFinal) {
        await handleFinalTranscript(session, transcript);
      }
    } catch (error) {
      console.error(`[deepgram][${session.callSid}] message parse error`, error);
    }
  });

  dg.on('close', () => {
    console.log(`[deepgram][${session.callSid}] closed`);
  });

  dg.on('error', (error) => {
    console.error(`[deepgram][${session.callSid}] error`, error);
  });
}

wss.on('connection', (ws) => {
  let callSid = '';
  let streamSid = '';

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        event: 'connected' | 'start' | 'media' | 'stop';
        start?: {
          accountSid?: string;
          callSid?: string;
          streamSid?: string;
          customParameters?: Record<string, string>;
        };
        media?: { track: string; payload: string };
        stop?: { callSid?: string };
      };

      if (msg.event === 'start' && msg.start?.callSid && msg.start?.streamSid) {
        callSid = msg.start.callSid;
        streamSid = msg.start.streamSid;
        const session: LiveSession = {
          callSid,
          streamSid,
          twilioWs: ws,
          segmentSeq: 0,
          lastFinalTranscript: '',
          playbackToken: 0,
          ttsPlaying: false,
          ended: false
        };
        sessions.set(callSid, session);
        openDeepgramForSession(session);

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

      if (msg.event === 'media' && callSid && msg.media?.payload) {
        const session = sessions.get(callSid);
        if (session?.ttsPlaying && rmsFromMulawPayload(msg.media.payload) > 700) {
          session.playbackToken += 1;
          clearTwilioPlayback(session);
          session.ttsPlaying = false;
        }

        if (session?.deepgramWs?.readyState === WebSocket.OPEN) {
          const audio = Buffer.from(msg.media.payload, 'base64');
          session.deepgramWs.send(audio);
        }

        const rawState = await redis.get(`call:${callSid}`);
        if (rawState) {
          const state = JSON.parse(rawState) as SessionState;
          state.mediaFrames += 1;
          await saveSession(callSid, state);
        }
      }

      if (msg.event === 'stop' && (msg.stop?.callSid || callSid)) {
        const id = msg.stop?.callSid ?? callSid;
        const session = sessions.get(id);
        if (session) {
          session.ended = true;
          if (session.deepgramWs?.readyState === WebSocket.OPEN) {
            session.deepgramWs.send(JSON.stringify({ type: 'Finalize' }));
            session.deepgramWs.close();
          }
          sessions.delete(id);
        }
        const rawState = await redis.get(`call:${id}`);
        if (rawState) {
          const state = JSON.parse(rawState) as SessionState;
          state.status = 'stopped';
          state.stoppedAt = new Date().toISOString();
          await saveSession(id, state);
        }
      }
    } catch (error) {
      console.error('media parse error', error);
    }
  });

  ws.on('close', () => {
    if (!callSid) return;
    const session = sessions.get(callSid);
    if (!session) return;
    session.ended = true;
    if (session.deepgramWs?.readyState === WebSocket.OPEN) {
      session.deepgramWs.close();
    }
    sessions.delete(callSid);
  });
});

server.listen(WS_PORT, () => {
  console.log(`media-ws listening on :${WS_PORT}`);
  console.log(
    `[config] REALTIME_DEEPGRAM_ENABLED=${REALTIME_DEEPGRAM_ENABLED} DEEPGRAM_MODEL=${DEEPGRAM_MODEL} DEEPGRAM_TTS_MODEL=${DEEPGRAM_TTS_MODEL}`
  );
});
