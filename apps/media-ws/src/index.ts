import dotenv from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import { Redis } from 'ioredis';
import { AgentEvents, createClient, type AgentLiveSchema, type FunctionCallResponse } from '@deepgram/sdk';
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
const DEEPGRAM_AGENT_LANGUAGE = process.env.DEEPGRAM_AGENT_LANGUAGE ?? 'en';
const DEEPGRAM_AGENT_LISTEN_MODEL = process.env.DEEPGRAM_AGENT_LISTEN_MODEL ?? 'nova-3';
const DEEPGRAM_AGENT_SPEAK_MODEL = process.env.DEEPGRAM_AGENT_SPEAK_MODEL ?? 'aura-2-thalia-en';
const DEEPGRAM_AGENT_GREETING =
  process.env.DEEPGRAM_AGENT_GREETING ??
  'Thanks for calling New Delhi Restaurant. Would you like to place an order or make a reservation?';
const DEEPGRAM_AGENT_PROMPT =
  process.env.DEEPGRAM_AGENT_PROMPT ??
  'You are the phone assistant for New Delhi Restaurant. Be warm and concise. First help with either pickup orders or table reservations. For orders, use function tools to validate menu items and totals before confirming. Never hallucinate unavailable menu items. Ask clarifying questions when details are missing. Confirm details before finalizing.';
const DEEPGRAM_AGENT_THINK_PROVIDER = process.env.DEEPGRAM_AGENT_THINK_PROVIDER ?? 'deepgram';
const DEEPGRAM_AGENT_THINK_MODEL = process.env.DEEPGRAM_AGENT_THINK_MODEL ?? '';

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

type FunctionCallRequest = {
  id: string;
  name: string;
  arguments: string;
  client_side?: boolean;
};

type LiveSession = {
  callSid: string;
  streamSid: string;
  twilioWs: WebSocket;
  agentConn?: ReturnType<ReturnType<typeof createClient>['agent']>;
  keepAliveTimer?: NodeJS.Timeout;
  playbackToken: number;
  ttsPlaying: boolean;
  ended: boolean;
  restaurantId?: string;
  calledNumber?: string;
};

const redis = new Redis(REDIS_URL);
redis.on('error', (error) => {
  console.error('redis connection error', error.message);
});

const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

const sessions = new Map<string, LiveSession>();
const deepgram = DEEPGRAM_API_KEY ? createClient(DEEPGRAM_API_KEY) : null;

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

function clearTwilioPlayback(session: LiveSession) {
  if (session.twilioWs.readyState !== WebSocket.OPEN) return;
  session.twilioWs.send(
    JSON.stringify({
      event: 'clear',
      streamSid: session.streamSid
    })
  );
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
        media: { payload: chunk.toString('base64') }
      })
    );
    await sleep(20);
  }

  session.ttsPlaying = false;
}

async function callInternalTool(toolName: string, args: Record<string, unknown>, session: LiveSession) {
  const endpoint = `${APP_BASE_URL}/agent/tools/${toolName}`;
  const body = {
    ...args,
    restaurant_id: String(args.restaurant_id ?? session.restaurantId ?? '')
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(INTERNAL_API_KEY ? { 'x-internal-api-key': INTERNAL_API_KEY } : {})
    },
    body: JSON.stringify(body)
  });

  const payloadText = await response.text();
  let payload: unknown = payloadText;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    // keep as plain text
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `tool ${toolName} failed with ${response.status}`,
      details: payload
    };
  }

  return payload;
}

async function respondToFunctionCalls(session: LiveSession, req: { functions?: FunctionCallRequest[] }) {
  const funcs = Array.isArray(req.functions) ? req.functions : [];
  if (!funcs.length || !session.agentConn) return;

  for (const fn of funcs) {
    const response: FunctionCallResponse = {
      id: fn.id,
      name: fn.name,
      content: ''
    };

    try {
      const parsedArgs = fn.arguments ? (JSON.parse(fn.arguments) as Record<string, unknown>) : {};
      const result = await callInternalTool(fn.name, parsedArgs, session);
      response.content = JSON.stringify(result);
      console.log(`[agent][${session.callSid}] tool=${fn.name} ok`);
    } catch (error) {
      response.content = JSON.stringify({ ok: false, error: String(error) });
      console.error(`[agent][${session.callSid}] tool=${fn.name} error`, error);
    }

    session.agentConn.functionCallResponse(response);
  }
}

function buildAgentConfig(session: LiveSession): AgentLiveSchema {
  const thinkProvider = {
    type: DEEPGRAM_AGENT_THINK_PROVIDER,
    ...(DEEPGRAM_AGENT_THINK_MODEL ? { model: DEEPGRAM_AGENT_THINK_MODEL } : {})
  };

  return {
    audio: {
      input: {
        encoding: 'mulaw',
        sample_rate: 8000
      },
      output: {
        encoding: 'mulaw',
        sample_rate: 8000,
        container: 'none'
      }
    },
    agent: {
      language: DEEPGRAM_AGENT_LANGUAGE,
      greeting: DEEPGRAM_AGENT_GREETING,
      listen: {
        provider: {
          type: 'deepgram',
          model: DEEPGRAM_AGENT_LISTEN_MODEL
        }
      },
      think: {
        provider: thinkProvider,
        prompt: `${DEEPGRAM_AGENT_PROMPT}\nRestaurantId: ${session.restaurantId ?? 'unknown'}\nCalledNumber: ${session.calledNumber ?? 'unknown'}`,
        functions: [
          {
            name: 'get_menu',
            description: 'Get current restaurant menu',
            parameters: {
              type: 'object',
              properties: { restaurant_id: { type: 'string' } },
              required: ['restaurant_id']
            }
          },
          {
            name: 'check_availability',
            description: 'Check table reservation availability',
            parameters: {
              type: 'object',
              properties: {
                restaurant_id: { type: 'string' },
                date: { type: 'string' },
                time: { type: 'string' },
                party_size: { type: 'integer' }
              },
              required: ['restaurant_id', 'date', 'time', 'party_size']
            }
          },
          {
            name: 'build_order',
            description: 'Validate and build a draft pickup order from menu items',
            parameters: {
              type: 'object',
              properties: {
                restaurant_id: { type: 'string' },
                customer_name: { type: 'string' },
                customer_phone: { type: 'string' },
                pickup_time: { type: 'string' },
                special_instructions: { type: 'string' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      quantity: { type: 'integer' },
                      options: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            name: { type: 'string' },
                            value: { type: 'string' }
                          },
                          required: ['name', 'value']
                        }
                      }
                    },
                    required: ['name', 'quantity']
                  }
                }
              },
              required: ['restaurant_id', 'customer_phone', 'pickup_time', 'items']
            }
          },
          {
            name: 'confirm_order',
            description: 'Persist a confirmed pickup order',
            parameters: {
              type: 'object',
              properties: {
                restaurant_id: { type: 'string' },
                customer_name: { type: 'string' },
                customer_phone: { type: 'string' },
                pickup_time: { type: 'string' },
                special_instructions: { type: 'string' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      quantity: { type: 'integer' },
                      options: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            name: { type: 'string' },
                            value: { type: 'string' }
                          },
                          required: ['name', 'value']
                        }
                      }
                    },
                    required: ['name', 'quantity']
                  }
                }
              },
              required: ['restaurant_id', 'customer_phone', 'pickup_time', 'items']
            }
          },
          {
            name: 'create_reservation',
            description: 'Create a restaurant reservation request',
            parameters: {
              type: 'object',
              properties: {
                restaurant_id: { type: 'string' },
                customer_name: { type: 'string' },
                customer_phone: { type: 'string' },
                date: { type: 'string' },
                time: { type: 'string' },
                party_size: { type: 'integer' },
                notes: { type: 'string' }
              },
              required: ['restaurant_id', 'customer_name', 'customer_phone', 'date', 'time', 'party_size']
            }
          }
        ]
      },
      speak: {
        provider: {
          type: 'deepgram',
          model: DEEPGRAM_AGENT_SPEAK_MODEL
        }
      }
    }
  };
}

function startDeepgramAgent(session: LiveSession) {
  if (!REALTIME_DEEPGRAM_ENABLED || !deepgram) return;

  const conn = deepgram.agent();
  session.agentConn = conn;

  conn.on(AgentEvents.Open, () => {
    console.log(`[agent][${session.callSid}] connected`);
    conn.configure(buildAgentConfig(session));
    session.keepAliveTimer = setInterval(() => conn.keepAlive(), 5000);
  });

  conn.on(AgentEvents.Close, () => {
    console.log(`[agent][${session.callSid}] closed`);
    if (session.keepAliveTimer) clearInterval(session.keepAliveTimer);
  });

  conn.on(AgentEvents.Error, (error) => {
    console.error(`[agent][${session.callSid}] error`, error);
  });

  conn.on(AgentEvents.ConversationText, (data: unknown) => {
    const d = data as { role?: string; content?: string };
    if (!d.content) return;
    console.log(`[agent][${session.callSid}] ${d.role ?? 'unknown'}=${d.content}`);
  });

  conn.on(AgentEvents.FunctionCallRequest, async (data: unknown) => {
    await respondToFunctionCalls(session, data as { functions?: FunctionCallRequest[] });
  });

  conn.on(AgentEvents.UserStartedSpeaking, () => {
    if (session.ttsPlaying) {
      session.playbackToken += 1;
      clearTwilioPlayback(session);
      session.ttsPlaying = false;
    }
  });

  conn.on(AgentEvents.Audio, async (chunk: Buffer) => {
    await playTwilioUlaw(session, Buffer.from(chunk));
  });
}

function stopSession(session: LiveSession) {
  session.ended = true;
  if (session.keepAliveTimer) clearInterval(session.keepAliveTimer);
  if (session.agentConn) {
    try {
      session.agentConn.disconnect();
    } catch {
      // ignore close race
    }
  }
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
          playbackToken: 0,
          ttsPlaying: false,
          ended: false,
          restaurantId: msg.start.customParameters?.restaurant_id,
          calledNumber: msg.start.customParameters?.called_number
        };
        sessions.set(callSid, session);
        startDeepgramAgent(session);

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

        if (session?.agentConn) {
          const audio = Buffer.from(msg.media.payload, 'base64');
          const ab = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength);
          session.agentConn.send(ab);
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
          stopSession(session);
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
    stopSession(session);
    sessions.delete(callSid);
  });
});

server.listen(WS_PORT, () => {
  console.log(`media-ws listening on :${WS_PORT}`);
  console.log(
    `[config] REALTIME_DEEPGRAM_ENABLED=${REALTIME_DEEPGRAM_ENABLED} DEEPGRAM_AGENT_LISTEN_MODEL=${DEEPGRAM_AGENT_LISTEN_MODEL} DEEPGRAM_AGENT_SPEAK_MODEL=${DEEPGRAM_AGENT_SPEAK_MODEL} DEEPGRAM_AGENT_THINK_PROVIDER=${DEEPGRAM_AGENT_THINK_PROVIDER} DEEPGRAM_AGENT_THINK_MODEL=${DEEPGRAM_AGENT_THINK_MODEL || 'default'}`
  );
});
