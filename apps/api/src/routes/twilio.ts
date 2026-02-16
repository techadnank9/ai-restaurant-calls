import { type Request, Router } from 'express';
import OpenAI from 'openai';
import twilio from 'twilio';
import { supabaseAdmin } from '../lib/supabase.js';
import { env } from '../lib/env.js';

const router = Router();
const DEFAULT_MEDIA_WS_URL = 'ws://localhost:8081/media-stream';
const MAX_TURNS = 6;

const openai = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null;

type ParsedOrderItem = {
  name: string;
  quantity: number;
};

type OrderTurn = {
  customer_name: string | null;
  pickup_time: string | null;
  items: ParsedOrderItem[];
  estimated_total: number;
  is_order_complete: boolean;
  assistant_reply: string;
  order_type: 'pickup';
};

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
    if (!url.pathname || url.pathname === '/') url.pathname = '/media-stream';
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

function sanitizeTurn(value: unknown): OrderTurn {
  const obj = (value ?? {}) as Record<string, unknown>;
  const itemsRaw = Array.isArray(obj.items) ? obj.items : [];

  const items: ParsedOrderItem[] = itemsRaw
    .map((item) => {
      const row = (item ?? {}) as Record<string, unknown>;
      const name = toStringValue(row.name);
      const quantity = Number(row.quantity ?? 1);
      if (!name) return null;
      return {
        name,
        quantity: Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity) : 1
      };
    })
    .filter(Boolean) as ParsedOrderItem[];

  return {
    customer_name: toStringValue(obj.customer_name) || null,
    pickup_time: toStringValue(obj.pickup_time) || null,
    items,
    estimated_total: Number.isFinite(Number(obj.estimated_total)) ? Number(obj.estimated_total) : 0,
    is_order_complete: Boolean(obj.is_order_complete),
    assistant_reply:
      toStringValue(obj.assistant_reply) ||
      'Please tell me your order items, your name, and pickup time.',
    order_type: 'pickup'
  };
}

function fallbackTurn(latestUtterance: string): OrderTurn {
  const pickupMatch = latestUtterance.match(
    /(\d{1,2}(:\d{2})?\s?(am|pm)|\d+\s?(minutes?|mins?)|as soon as possible)/i
  );

  return {
    customer_name: null,
    pickup_time: pickupMatch ? pickupMatch[0] : null,
    items: [],
    estimated_total: 0,
    is_order_complete: false,
    assistant_reply: 'Please tell me your order items, your name, and pickup time.',
    order_type: 'pickup'
  };
}

async function runOrderTurn(
  restaurantName: string,
  transcript: string,
  latestUtterance: string
): Promise<OrderTurn> {
  if (!openai) return fallbackTurn(latestUtterance);

  try {
    const completion = await openai.chat.completions.create({
      model: env.OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You are a restaurant phone ordering agent for pickup orders. Collect customer name, order items with quantity, and pickup time. Keep responses short and clear. If data is missing, ask one focused follow-up question. Set is_order_complete=true only when name, at least one item, and pickup_time are all captured.'
        },
        {
          role: 'user',
          content: JSON.stringify({
            restaurant_name: restaurantName,
            latest_utterance: latestUtterance,
            conversation_transcript: transcript
          })
        }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'order_turn',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              customer_name: { type: ['string', 'null'] },
              pickup_time: { type: ['string', 'null'] },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string' },
                    quantity: { type: 'integer', minimum: 1 }
                  },
                  required: ['name', 'quantity']
                }
              },
              estimated_total: { type: 'number' },
              is_order_complete: { type: 'boolean' },
              assistant_reply: { type: 'string' },
              order_type: { type: 'string', enum: ['pickup'] }
            },
            required: [
              'customer_name',
              'pickup_time',
              'items',
              'estimated_total',
              'is_order_complete',
              'assistant_reply',
              'order_type'
            ]
          }
        }
      } as never
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return fallbackTurn(latestUtterance);

    return sanitizeTurn(JSON.parse(content));
  } catch {
    return fallbackTurn(latestUtterance);
  }
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

  const converseUrl = buildUrl(req, '/twilio/converse', {
    restaurant_id: restaurant.id,
    called,
    from,
    turn: '1'
  });

  const gather = response.gather({
    input: ['speech'],
    speechTimeout: 'auto',
    method: 'POST',
    action: converseUrl
  });

  gather.say({ voice: 'alice' }, 'Hi, thanks for calling. Please tell me your pickup order.');
  response.say({ voice: 'alice' }, 'Sorry, I did not hear anything. Goodbye.');
  response.hangup();

  res.type('text/xml').send(response.toString());
});

router.post('/converse', async (req, res) => {
  const restaurantIdFromQuery = toStringValue(req.query.restaurant_id);
  const called = normalizePhone(req.query.called);
  const from = normalizePhone(req.body?.From || req.query.from);
  const turnCount = Math.max(1, Number(toStringValue(req.query.turn) || '1'));
  const callSid = toStringValue(req.body?.CallSid);
  const utterance = toStringValue(req.body?.SpeechResult);

  const twiml = new twilio.twiml.VoiceResponse();

  if (!utterance) {
    const retryUrl = buildUrl(req, '/twilio/converse', {
      restaurant_id: restaurantIdFromQuery,
      called,
      from,
      turn: String(turnCount)
    });

    const retryGather = twiml.gather({
      input: ['speech'],
      speechTimeout: 'auto',
      method: 'POST',
      action: retryUrl
    });
    retryGather.say({ voice: 'alice' }, 'I did not catch that. Please repeat your order details.');
    twiml.say({ voice: 'alice' }, 'Still no response. Goodbye.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const { data: existingCall } = callSid
    ? await supabaseAdmin
        .from('calls')
        .select('restaurant_id, transcript')
        .eq('twilio_call_sid', callSid)
        .maybeSingle()
    : { data: null };

  const restaurantId = restaurantIdFromQuery || existingCall?.restaurant_id || '';

  const { data: restaurant } = restaurantId
    ? await supabaseAdmin
        .from('restaurants')
        .select('name')
        .eq('id', restaurantId)
        .maybeSingle()
    : { data: null };

  const transcriptPrefix = existingCall?.transcript ? `${existingCall.transcript}\n` : '';
  const transcriptWithUser = `${transcriptPrefix}Customer: ${utterance}`;

  const turn = await runOrderTurn(restaurant?.name ?? 'Restaurant', transcriptWithUser, utterance);
  const transcriptWithAssistant = `${transcriptWithUser}\nAssistant: ${turn.assistant_reply}`;

  if (callSid) {
    await supabaseAdmin.from('calls').upsert(
      {
        twilio_call_sid: callSid,
        restaurant_id: restaurantId || null,
        transcript: transcriptWithAssistant,
        status: 'in_progress'
      },
      { onConflict: 'twilio_call_sid' }
    );
  }

  const isComplete = turn.is_order_complete && !!turn.pickup_time && turn.items.length > 0;

  if (isComplete && restaurantId) {
    const itemsJson = turn.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unit_price: 0,
      options: []
    }));

    await supabaseAdmin.from('orders').insert({
      restaurant_id: restaurantId,
      customer_phone: from || 'unknown',
      items_json: itemsJson,
      total_price: Math.max(0, Number(turn.estimated_total || 0)),
      pickup_time: turn.pickup_time,
      status: 'pending',
      transcript: transcriptWithAssistant,
      ai_confidence: 0.85
    });

    if (callSid) {
      await supabaseAdmin.from('calls').upsert(
        {
          twilio_call_sid: callSid,
          restaurant_id: restaurantId,
          transcript: transcriptWithAssistant,
          status: 'completed'
        },
        { onConflict: 'twilio_call_sid' }
      );
    }

    twiml.say({ voice: 'alice' }, turn.assistant_reply || 'Thanks, your pickup order is confirmed. Goodbye.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  if (turnCount >= MAX_TURNS) {
    twiml.say({ voice: 'alice' }, 'I could not complete your order details. Please call again. Goodbye.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const nextUrl = buildUrl(req, '/twilio/converse', {
    restaurant_id: restaurantId,
    called,
    from,
    turn: String(turnCount + 1)
  });

  const gather = twiml.gather({
    input: ['speech'],
    speechTimeout: 'auto',
    method: 'POST',
    action: nextUrl
  });
  gather.say({ voice: 'alice' }, turn.assistant_reply);

  twiml.say({ voice: 'alice' }, 'Sorry, I did not get that. Please call again.');
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
