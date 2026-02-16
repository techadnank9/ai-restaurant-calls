import dotenv from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import { Redis } from 'ioredis';
import { WebSocketServer } from 'ws';

dotenv.config({ path: '../../.env' });
dotenv.config();

const WS_PORT = Number(process.env.PORT ?? process.env.WS_PORT ?? 8081);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

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

async function saveSession(callSid: string, state: SessionState) {
  await redis.set(`call:${callSid}`, JSON.stringify(state), 'EX', 60 * 60 * 2);
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
        const rawState = await redis.get(`call:${callSid}`);
        if (!rawState) return;
        const state = JSON.parse(rawState) as SessionState;
        state.mediaFrames += 1;
        await saveSession(callSid, state);
      }

      if (msg.event === 'stop' && (msg.stop?.callSid || callSid)) {
        const id = msg.stop?.callSid ?? callSid;
        const rawState = await redis.get(`call:${id}`);
        if (!rawState) return;
        const state = JSON.parse(rawState) as SessionState;
        state.status = 'stopped';
        state.stoppedAt = new Date().toISOString();
        await saveSession(id, state);
      }
    } catch (error) {
      console.error('media parse error', error);
    }
  });
});

server.listen(WS_PORT, () => {
  console.log(`media-ws listening on :${WS_PORT}`);
});
