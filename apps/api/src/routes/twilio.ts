import { type Request, Router } from 'express';
import twilio from 'twilio';
import { supabaseAdmin } from '../lib/supabase.js';
import { env } from '../lib/env.js';

const router = Router();
const DEFAULT_MEDIA_WS_URL = 'ws://localhost:8081/media-stream';

function toStringValue(input: unknown) {
  if (Array.isArray(input)) return String(input[0] ?? '').trim();
  return String(input ?? '').trim();
}

function normalizePhone(input: unknown) {
  const value = toStringValue(input);
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

function buildUrl(req: Request, pathname: string, params?: Record<string, string>) {
  const url = new URL(pathname, requestBaseUrl(req));
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

router.post('/voice', async (req, res) => {
  const called = normalizePhone(req.body?.Called ?? req.body?.To);
  const from = normalizePhone(req.body?.From);
  const callSid = toStringValue(req.body?.CallSid);

  const { data: restaurant } = await supabaseAdmin
    .from('restaurants')
    .select('id, name')
    .eq('twilio_number', called)
    .limit(1)
    .maybeSingle();

  if (callSid) {
    await supabaseAdmin.from('calls').upsert(
      {
        twilio_call_sid: callSid,
        restaurant_id: restaurant?.id ?? null,
        status: 'in_progress'
      },
      { onConflict: 'twilio_call_sid' }
    );
  }

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

  if (!restaurant?.id) {
    response.say('Sorry, this number is not configured yet. Please try again later.');
    response.hangup();
    return res.type('text/xml').send(response.toString());
  }

  const captureOrderUrl = buildUrl(req, '/twilio/capture-order', {
    restaurant_id: restaurant.id,
    called,
    from
  });

  const gather = response.gather({
    input: ['speech'],
    speechTimeout: 'auto',
    method: 'POST',
    action: captureOrderUrl
  });

  gather.say({ voice: 'alice' }, 'Hi, thanks for calling. Please say your pickup order now.');
  response.say({ voice: 'alice' }, 'Sorry, I did not hear anything. Goodbye.');
  response.hangup();

  res.type('text/xml').send(response.toString());
});

router.post('/capture-order', async (req, res) => {
  const restaurantId = toStringValue(req.query.restaurant_id);
  const called = normalizePhone(req.query.called);
  const from = normalizePhone(req.body?.From || req.query.from);
  const callSid = toStringValue(req.body?.CallSid);
  const orderText = toStringValue(req.body?.SpeechResult);

  const twiml = new twilio.twiml.VoiceResponse();

  const captureOrderUrl = buildUrl(req, '/twilio/capture-order', {
    restaurant_id: restaurantId,
    called,
    from
  });

  if (!orderText) {
    const gatherRetry = twiml.gather({
      input: ['speech'],
      speechTimeout: 'auto',
      method: 'POST',
      action: captureOrderUrl
    });
    gatherRetry.say({ voice: 'alice' }, 'I did not catch your order. Please say your order now.');
    twiml.say({ voice: 'alice' }, 'Still no response. Goodbye.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  if (callSid) {
    await supabaseAdmin.from('calls').upsert(
      {
        twilio_call_sid: callSid,
        restaurant_id: restaurantId || null,
        transcript: orderText,
        status: 'in_progress'
      },
      { onConflict: 'twilio_call_sid' }
    );
  }

  const finalizeUrl = buildUrl(req, '/twilio/finalize-order', {
    restaurant_id: restaurantId,
    from,
    called
  });

  const pickupGather = twiml.gather({
    input: ['speech'],
    speechTimeout: 'auto',
    method: 'POST',
    action: finalizeUrl
  });
  pickupGather.say({ voice: 'alice' }, `Got it. You said: ${orderText}. What pickup time works for you?`);
  twiml.say({ voice: 'alice' }, 'I did not hear a pickup time. Goodbye.');
  twiml.hangup();

  return res.type('text/xml').send(twiml.toString());
});

router.post('/finalize-order', async (req, res) => {
  const restaurantIdFromQuery = toStringValue(req.query.restaurant_id);
  const from = normalizePhone(req.body?.From || req.query.from);
  const callSid = toStringValue(req.body?.CallSid);
  const pickupTime = toStringValue(req.body?.SpeechResult) || 'as soon as possible';

  let orderText = 'Phone order';
  let restaurantId = restaurantIdFromQuery;

  if (callSid) {
    const { data: existingCall } = await supabaseAdmin
      .from('calls')
      .select('restaurant_id, transcript')
      .eq('twilio_call_sid', callSid)
      .maybeSingle();

    if (existingCall?.transcript) orderText = existingCall.transcript;
    if (!restaurantId && existingCall?.restaurant_id) restaurantId = existingCall.restaurant_id;
  }

  if (restaurantId) {
    await supabaseAdmin.from('orders').insert({
      restaurant_id: restaurantId,
      customer_phone: from || 'unknown',
      items_json: [{ name: orderText, quantity: 1, unit_price: 0, options: [] }],
      total_price: 0,
      pickup_time: pickupTime,
      status: 'pending',
      transcript: orderText,
      ai_confidence: 0.5
    });
  }

  if (callSid) {
    await supabaseAdmin.from('calls').upsert(
      {
        twilio_call_sid: callSid,
        restaurant_id: restaurantId || null,
        transcript: `${orderText}\nPickup time: ${pickupTime}`,
        status: 'completed'
      },
      { onConflict: 'twilio_call_sid' }
    );
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'alice' }, `Thanks. Your order is confirmed for pickup at ${pickupTime}. Goodbye.`);
  twiml.hangup();
  return res.type('text/xml').send(twiml.toString());
});

router.post('/recording-complete', async (req, res) => {
  const callSid = toStringValue(req.body?.CallSid);
  const recordingUrl = toStringValue(req.body?.RecordingUrl);

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
