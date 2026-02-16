import { type Request, Router } from 'express';
import twilio from 'twilio';
import { supabaseAdmin } from '../lib/supabase.js';
import { env } from '../lib/env.js';

const router = Router();
const DEFAULT_MEDIA_WS_URL = 'ws://localhost:8081/media-stream';

function normalizePhone(input: unknown) {
  const value = String(input ?? '').trim();
  if (!value) return '';
  if (value.startsWith('+')) return value;
  if (/^\d+$/.test(value)) return `+${value}`;
  return value;
}

function normalizeMediaWsUrl(raw: string) {
  const source = (raw || DEFAULT_MEDIA_WS_URL).trim();

  try {
    const url = new URL(source);
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return DEFAULT_MEDIA_WS_URL;
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/media-stream';
    }
    return url.toString();
  } catch {
    return DEFAULT_MEDIA_WS_URL;
  }
}

function requestBaseUrl(req: Request) {
  const forwardedProto = req.get('x-forwarded-proto');
  const forwardedHost = req.get('x-forwarded-host');
  const protocol = (forwardedProto ? forwardedProto.split(',')[0] : req.protocol).trim();
  const host = (forwardedHost ?? req.get('host') ?? '').trim();
  if (!host) return env.APP_BASE_URL;
  return `${protocol}://${host}`;
}

router.post('/voice', async (req, res) => {
  const called = normalizePhone(req.body?.Called ?? req.body?.To);

  const { data: restaurant } = await supabaseAdmin
    .from('restaurants')
    .select('id, name')
    .eq('twilio_number', called)
    .limit(1)
    .maybeSingle();

  const response = new twilio.twiml.VoiceResponse();
  const start = response.start();
  const stream = start.stream({
    url: normalizeMediaWsUrl(env.MEDIA_WS_URL)
  });

  if (restaurant?.id) {
    stream.parameter({ name: 'restaurant_id', value: restaurant.id });
    stream.parameter({ name: 'restaurant_name', value: restaurant.name });
  }
  stream.parameter({ name: 'called_number', value: called });

  response.say({ voice: 'alice' }, 'Hi, thanks for calling. Please tell me your pickup order after the beep.');
  const actionUrl = new URL('/twilio/recording-complete', requestBaseUrl(req)).toString();
  response.record({
    transcribe: true,
    maxLength: 120,
    playBeep: true,
    action: actionUrl,
    method: 'POST'
  });

  res.type('text/xml').send(response.toString());
});

router.post('/recording-complete', async (req, res) => {
  const callSid = String(req.body?.CallSid ?? '');
  const recordingUrl = String(req.body?.RecordingUrl ?? '');

  if (callSid) {
    await supabaseAdmin.from('calls').upsert(
      {
        twilio_call_sid: callSid,
        recording_url: recordingUrl,
        status: 'completed'
      },
      { onConflict: 'twilio_call_sid' }
    );
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Thank you. Your order is being processed. Goodbye.');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

export default router;
