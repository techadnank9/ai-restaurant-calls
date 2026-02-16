import { type Request, Router } from 'express';
import { Redis } from 'ioredis';
import OpenAI from 'openai';
import twilio from 'twilio';
import { supabaseAdmin } from '../lib/supabase.js';
import { env } from '../lib/env.js';

const router = Router();
const DEFAULT_MEDIA_WS_URL = 'ws://localhost:8081/media-stream';
const MAX_TURNS = 6;
const STATE_TTL_SECONDS = 60 * 30;
const ASSISTANT_VOICE = 'Polly.Joanna';
const RETRY_LINES = [
  'Sorry, I missed that. Could you say your order one more time?',
  'Thanks. I did not catch it clearly. Please repeat the item and quantity.',
  'Sorry about that. Please repeat slowly, and I will get it right.'
];

const openai = env.LLM_API_KEY
  ? new OpenAI({
      apiKey: env.LLM_API_KEY,
      ...(env.LLM_BASE_URL ? { baseURL: env.LLM_BASE_URL } : {})
    })
  : null;
const redis = new Redis(env.REDIS_URL);
redis.on('error', (err: Error) => {
  console.error('api redis error', err.message);
});

type GatherStage =
  | 'GREETING'
  | 'COLLECT_ITEMS'
  | 'COLLECT_NAME'
  | 'COLLECT_PICKUP_TIME'
  | 'CONFIRM_ORDER'
  | 'COMPLETE';

type MenuItem = {
  name: string;
  basePrice: number;
  aliases: string[];
};

type VoiceConfig = {
  brandName: string;
  greetingText: string;
  greetingFollowupText: string;
  strictMenuValidation: boolean;
  orderTypeDefault: 'pickup';
};

type ValidatedOrderItem = {
  name: string;
  quantity: number;
  unit_price: number;
  options: { name: string; value: string }[];
};

type CallState = {
  stage: GatherStage;
  turnCount: number;
  transcriptLines: string[];
  customerName: string | null;
  customerPhone: string;
  pickupTime: string | null;
  items: ValidatedOrderItem[];
  unknownItems: string[];
  awaitingConfirmation: boolean;
  restaurantId: string;
  restaurantName: string;
  strictMenuValidation: boolean;
  menuItems: MenuItem[];
};

type LlmOrderItem = {
  name: string;
  quantity: number;
  options?: { name: string; value: string }[];
};

type OrderTurn = {
  customer_name: string | null;
  pickup_time: string | null;
  items: LlmOrderItem[];
  unknown_items: string[];
  estimated_total: number;
  is_order_complete: boolean;
  assistant_reply: string;
  next_question: string | null;
  order_type: 'pickup';
};

type MediaTranscriptBody = {
  callSid?: string;
  transcript?: string;
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

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeMenu(menuJson: unknown): MenuItem[] {
  const menu = (menuJson ?? {}) as Record<string, unknown>;
  const categories = Array.isArray(menu.categories) ? menu.categories : [];
  const output: MenuItem[] = [];

  for (const category of categories) {
    const items = Array.isArray((category as Record<string, unknown>).items)
      ? ((category as Record<string, unknown>).items as unknown[])
      : [];

    for (const rawItem of items) {
      const item = (rawItem ?? {}) as Record<string, unknown>;
      const name = toStringValue(item.name);
      if (!name) continue;
      const basePrice = Number(item.price ?? 0);
      const aliases = Array.isArray(item.aliases)
        ? item.aliases.map((a) => toStringValue(a)).filter(Boolean)
        : [];

      output.push({
        name,
        basePrice: Number.isFinite(basePrice) ? basePrice : 0,
        aliases
      });
    }
  }

  return output;
}

function readVoiceConfig(restaurantName: string, menuJson: unknown): VoiceConfig {
  const menu = (menuJson ?? {}) as Record<string, unknown>;
  const meta = ((menu.meta ?? {}) as Record<string, unknown>) || {};

  const brandName = toStringValue(meta.brand_name) || restaurantName;
  const greetingText =
    toStringValue(meta.greeting_text) ||
    `Hi, thanks for calling ${brandName}.`;
  const greetingFollowupText =
    toStringValue(meta.greeting_followup_text) ||
    'What can I get started for your pickup order today?';

  const strictRaw = toStringValue(meta.strict_menu_validation).toLowerCase();
  const strictMenuValidation = strictRaw ? strictRaw !== 'false' : true;

  return {
    brandName,
    greetingText,
    greetingFollowupText,
    strictMenuValidation,
    orderTypeDefault: 'pickup'
  };
}

function findMenuMatch(name: string, menuItems: MenuItem[]) {
  const target = normalizeKey(name);
  if (!target) return null;

  const exact = menuItems.find((item) => normalizeKey(item.name) === target);
  if (exact) return exact;

  const alias = menuItems.find((item) => item.aliases.some((a) => normalizeKey(a) === target));
  return alias ?? null;
}

function sanitizeTurn(value: unknown): OrderTurn {
  const obj = (value ?? {}) as Record<string, unknown>;
  const itemsRaw = Array.isArray(obj.items) ? obj.items : [];
  const unknownRaw = Array.isArray(obj.unknown_items) ? obj.unknown_items : [];

  const items: LlmOrderItem[] = itemsRaw
    .map((item) => {
      const row = (item ?? {}) as Record<string, unknown>;
      const name = toStringValue(row.name);
      if (!name) return null;
      const quantity = Number(row.quantity ?? 1);
      const optionsRaw = Array.isArray(row.options) ? row.options : [];
      const options = optionsRaw
        .map((o) => ({
          name: toStringValue((o as Record<string, unknown>).name),
          value: toStringValue((o as Record<string, unknown>).value)
        }))
        .filter((o) => o.name && o.value);

      return {
        name,
        quantity: Number.isFinite(quantity) && quantity > 0 ? Math.round(quantity) : 1,
        options
      };
    })
    .filter(Boolean) as LlmOrderItem[];

  return {
    customer_name: toStringValue(obj.customer_name) || null,
    pickup_time: toStringValue(obj.pickup_time) || null,
    items,
    unknown_items: unknownRaw.map((x) => toStringValue(x)).filter(Boolean),
    estimated_total: Number.isFinite(Number(obj.estimated_total)) ? Number(obj.estimated_total) : 0,
    is_order_complete: Boolean(obj.is_order_complete),
    assistant_reply:
      toStringValue(obj.assistant_reply) ||
      'Please share your order items, your name, and your pickup time.',
    next_question: toStringValue(obj.next_question) || null,
    order_type: 'pickup'
  };
}

function fallbackTurn(assistantReply = 'Please share your order items, your name, and your pickup time.'): OrderTurn {
  return {
    customer_name: null,
    pickup_time: null,
    items: [],
    unknown_items: [],
    estimated_total: 0,
    is_order_complete: false,
    assistant_reply: assistantReply,
    next_question: null,
    order_type: 'pickup'
  };
}

function sanitizeSpeechReply(reply: string) {
  const trimmed = reply.replace(/\s+/g, ' ').trim();
  if (!trimmed) return 'Please share your order items, your name, and your pickup time.';
  return trimmed.slice(0, 260);
}

function friendlyConfirmReply(state: CallState) {
  const summary = summarizeItems(state.items);
  return `Great, I have ${summary} for pickup at ${state.pickupTime} under ${state.customerName}. Does that sound right?`;
}

function confirmationClosing(name: string | null, pickupTime: string | null) {
  const callerName = name?.trim() ? name.trim() : 'there';
  const pickup = pickupTime?.trim() ? pickupTime.trim() : 'the requested time';
  return `Perfect, ${callerName}. Your pickup order is confirmed for ${pickup}. We will have it ready.`;
}

async function runOrderTurn(
  callSid: string,
  callState: CallState,
  latestUtterance: string,
  availableMenu: MenuItem[]
): Promise<OrderTurn> {
  if (!openai) {
    console.warn(`[gpt][${callSid}] OPENAI disabled, using fallback turn`);
    return fallbackTurn(
      'Our AI ordering is temporarily unavailable. Please hold for staff or call again in a few minutes.'
    );
  }

  try {
    const payload = {
      restaurant_name: callState.restaurantName,
      stage: callState.stage,
      latest_utterance: latestUtterance,
      collected: {
        customer_name: callState.customerName,
        pickup_time: callState.pickupTime,
        items: callState.items
      },
      available_menu: availableMenu
    };
    console.log(`[gpt][${callSid}] prompt=${JSON.stringify(payload)}`);

    const completion = await openai.chat.completions.create({
      model: env.LLM_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You are a highly natural restaurant phone ordering agent. Speak like a friendly human host, not a bot. Use contractions and short spoken phrasing. Keep each turn to 1-2 brief sentences (max 22 words each). Ask exactly one clear follow-up question. Use only items from AVAILABLE_MENU and never invent menu items. Collect customer_name, pickup_time, and item quantities. If an item is unknown, add it to unknown_items and politely offer available menu alternatives. Mark is_order_complete true only when customer_name, at least one valid item, and pickup_time are present.'
        },
        {
          role: 'user',
          content: JSON.stringify(payload)
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
                    quantity: { type: 'integer', minimum: 1 },
                    options: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          name: { type: 'string' },
                          value: { type: 'string' }
                        },
                        required: ['name', 'value']
                      }
                    }
                  },
                  required: ['name', 'quantity', 'options']
                }
              },
              unknown_items: {
                type: 'array',
                items: { type: 'string' }
              },
              estimated_total: { type: 'number' },
              is_order_complete: { type: 'boolean' },
              assistant_reply: { type: 'string' },
              next_question: { type: ['string', 'null'] },
              order_type: { type: 'string', enum: ['pickup'] }
            },
            required: [
              'customer_name',
              'pickup_time',
              'items',
              'unknown_items',
              'estimated_total',
              'is_order_complete',
              'assistant_reply',
              'next_question',
              'order_type'
            ]
          }
        }
      } as never
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return fallbackTurn();
    console.log(`[gpt][${callSid}] raw_response=${content}`);
    const parsed = sanitizeTurn(JSON.parse(content));
    console.log(`[gpt][${callSid}] parsed_turn=${JSON.stringify(parsed)}`);
    return parsed;
  } catch (error) {
    const maybeError = error as {
      code?: string;
      type?: string;
      status?: number;
      message?: string;
    };
    console.error(
      `[gpt][${callSid}] error status=${maybeError?.status ?? 'unknown'} code=${
        maybeError?.code ?? 'unknown'
      } type=${maybeError?.type ?? 'unknown'} message=${maybeError?.message ?? 'unknown'}`
    );
    if (
      maybeError?.status === 429 ||
      maybeError?.code === 'insufficient_quota' ||
      maybeError?.type === 'insufficient_quota'
    ) {
      return fallbackTurn(
        'Our AI ordering is temporarily unavailable right now. Please hold for staff or call back shortly.'
      );
    }
    return fallbackTurn();
  }
}

function summarizeItems(items: ValidatedOrderItem[]) {
  if (items.length === 0) return 'no items';
  return items.map((i) => `${i.quantity} ${i.name}`).join(', ');
}

function determineStage(state: CallState): GatherStage {
  if (state.awaitingConfirmation) return 'CONFIRM_ORDER';
  if (state.items.length === 0) return 'COLLECT_ITEMS';
  if (!state.customerName) return 'COLLECT_NAME';
  if (!state.pickupTime) return 'COLLECT_PICKUP_TIME';
  return 'COMPLETE';
}

function parseConfirmation(text: string) {
  const normalized = text.toLowerCase();
  if (/\b(yes|correct|confirm|right|yep|yeah)\b/.test(normalized)) return 'yes';
  if (/\b(no|wrong|change|not correct|nah)\b/.test(normalized)) return 'no';
  return 'unknown';
}

async function loadCallState(callSid: string): Promise<CallState | null> {
  const raw = await redis.get(`call_state:${callSid}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CallState;
  } catch {
    return null;
  }
}

async function saveCallState(callSid: string, state: CallState) {
  await redis.set(`call_state:${callSid}`, JSON.stringify(state), 'EX', STATE_TTL_SECONDS);
}

async function failCall(callSid: string, message: string) {
  await supabaseAdmin.from('calls').upsert(
    {
      twilio_call_sid: callSid,
      status: 'failed',
      transcript: message
    },
    { onConflict: 'twilio_call_sid' }
  );
}

async function completeOrder(callSid: string, state: CallState) {
  const totalPrice = state.items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
  const transcript = state.transcriptLines.join('\n');

  await supabaseAdmin.from('orders').insert({
    restaurant_id: state.restaurantId,
    customer_name: state.customerName ?? 'Unknown',
    customer_phone: state.customerPhone || 'unknown',
    items_json: state.items,
    total_price: totalPrice,
    pickup_time: state.pickupTime ?? 'as soon as possible',
    status: 'pending',
    transcript,
    ai_confidence: 0.9
  });

  await supabaseAdmin.from('calls').upsert(
    {
      twilio_call_sid: callSid,
      restaurant_id: state.restaurantId,
      transcript,
      status: 'completed'
    },
    { onConflict: 'twilio_call_sid' }
  );
}

async function processTranscriptTurn(callSid: string, transcript: string) {
  const state = await loadCallState(callSid);
  if (!state) {
    await failCall(callSid, `Missing call state for transcript: ${transcript}`);
    return { ok: false, status: 404 as const, body: { error: 'call state not found' } };
  }

  state.transcriptLines.push(`Customer: ${transcript}`);
  const llmTurn = await runOrderTurn(callSid, state, transcript, state.menuItems);

  if (llmTurn.customer_name) state.customerName = llmTurn.customer_name;
  if (llmTurn.pickup_time) state.pickupTime = llmTurn.pickup_time;

  const validatedItems: ValidatedOrderItem[] = [];
  const unknown: string[] = [];
  for (const item of llmTurn.items) {
    const matched = findMenuMatch(item.name, state.menuItems);
    if (!matched && state.strictMenuValidation) {
      unknown.push(item.name);
      continue;
    }
    if (matched) {
      validatedItems.push({
        name: matched.name,
        quantity: Math.max(1, Number(item.quantity || 1)),
        unit_price: matched.basePrice,
        options: item.options ?? []
      });
    }
  }

  for (const u of llmTurn.unknown_items) {
    if (u && !unknown.includes(u)) unknown.push(u);
  }

  if (validatedItems.length > 0) state.items = validatedItems;
  state.unknownItems = unknown;
  state.stage = determineStage(state);

  let assistantReply = sanitizeSpeechReply(llmTurn.assistant_reply);
  if (unknown.length > 0) {
    const examples = state.menuItems.slice(0, 5).map((i) => i.name).join(', ');
    assistantReply = `Sorry, I could not find ${unknown.join(
      ', '
    )} on our menu. You can choose items like ${examples}. What would you like instead?`;
    state.stage = 'COLLECT_ITEMS';
  } else if (state.stage === 'COMPLETE') {
    assistantReply = friendlyConfirmReply(state);
    state.awaitingConfirmation = true;
    state.stage = 'CONFIRM_ORDER';
  }

  state.transcriptLines.push(`Assistant: ${assistantReply}`);

  if (
    llmTurn.is_order_complete &&
    !unknown.length &&
    state.items.length > 0 &&
    state.customerName &&
    state.pickupTime
  ) {
    await completeOrder(callSid, state);
    await saveCallState(callSid, { ...state, stage: 'COMPLETE', awaitingConfirmation: false });
    return { ok: true, status: 200 as const, body: { ok: true, saved: true, assistant_reply: assistantReply } };
  }

  await supabaseAdmin.from('calls').upsert(
    {
      twilio_call_sid: callSid,
      restaurant_id: state.restaurantId,
      transcript: state.transcriptLines.join('\n'),
      status: 'in_progress'
    },
    { onConflict: 'twilio_call_sid' }
  );

  await saveCallState(callSid, state);
  return { ok: true, status: 200 as const, body: { ok: true, saved: false, assistant_reply: assistantReply } };
}

router.post('/voice', async (req, res) => {
  const called = normalizePhone(req.body?.Called ?? req.body?.To);
  const from = normalizePhone(req.body?.From);
  const callSid = toStringValue(req.body?.CallSid);

  const { data: restaurant } = await supabaseAdmin
    .from('restaurants')
    .select('id, name, menu_json')
    .eq('twilio_number', called)
    .limit(1)
    .maybeSingle();

  const response = new twilio.twiml.VoiceResponse();

  if (!restaurant?.id) {
    response.say(
      { voice: ASSISTANT_VOICE },
      'Sorry, this number is not set up yet. Please call again later.'
    );
    response.hangup();
    return res.type('text/xml').send(response.toString());
  }

  const menuItems = normalizeMenu(restaurant.menu_json);
  const voiceConfig = readVoiceConfig(restaurant.name, restaurant.menu_json);

  if (callSid) {
    await supabaseAdmin.from('calls').upsert(
      {
        twilio_call_sid: callSid,
        restaurant_id: restaurant.id,
        status: 'in_progress',
        transcript: ''
      },
      { onConflict: 'twilio_call_sid' }
    );

    const state: CallState = {
      stage: 'GREETING',
      turnCount: 0,
      transcriptLines: [],
      customerName: null,
      customerPhone: from || 'unknown',
      pickupTime: null,
      items: [],
      unknownItems: [],
      awaitingConfirmation: false,
      restaurantId: restaurant.id,
      restaurantName: voiceConfig.brandName,
      strictMenuValidation: voiceConfig.strictMenuValidation,
      menuItems
    };

    await saveCallState(callSid, state);
  }

  const start = response.start();
  const stream = start.stream({ url: normalizeMediaWsUrl(env.MEDIA_WS_URL) });
  stream.parameter({ name: 'restaurant_id', value: restaurant.id });
  stream.parameter({ name: 'restaurant_name', value: voiceConfig.brandName });
  stream.parameter({ name: 'called_number', value: called });

  const converseUrl = buildUrl(req, '/twilio/converse', {
    restaurant_id: restaurant.id,
    called,
    from,
    turn: '1'
  });

  if (!env.TWILIO_SPEECH_GATHER_ENABLED) {
    response.say(
      { voice: ASSISTANT_VOICE },
      `${voiceConfig.greetingText} ${voiceConfig.greetingFollowupText} Please say your full pickup order, your name, and your pickup time after the tone.`
    );
    response.pause({ length: 300 });
    response.say(
      { voice: ASSISTANT_VOICE },
      'Sorry, we could not complete your order this time. Please call again.'
    );
    response.hangup();
    return res.type('text/xml').send(response.toString());
  }

  const gather = response.gather({
    input: ['speech'],
    speechTimeout: 'auto',
    method: 'POST',
    action: converseUrl
  });
  gather.say({ voice: ASSISTANT_VOICE }, `${voiceConfig.greetingText} ${voiceConfig.greetingFollowupText}`);

  response.say({ voice: ASSISTANT_VOICE }, 'Sorry, I did not hear anything. Goodbye.');
  response.hangup();

  res.type('text/xml').send(response.toString());
});

router.post('/converse', async (req, res) => {
  const callSid = toStringValue(req.body?.CallSid);
  const spoken = toStringValue(req.body?.SpeechResult);
  const fallbackRestaurantId = toStringValue(req.query.restaurant_id);
  const from = normalizePhone(req.body?.From || req.query.from);
  const called = normalizePhone(req.query.called);

  const twiml = new twilio.twiml.VoiceResponse();

  if (!callSid) {
    twiml.say({ voice: ASSISTANT_VOICE }, 'We could not identify your call. Please call again.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  let state = await loadCallState(callSid);

  if (!state && fallbackRestaurantId) {
    const { data: restaurant } = await supabaseAdmin
      .from('restaurants')
      .select('id, name, menu_json')
      .eq('id', fallbackRestaurantId)
      .maybeSingle();

    if (restaurant) {
      const voiceConfig = readVoiceConfig(restaurant.name, restaurant.menu_json);
      state = {
        stage: 'COLLECT_ITEMS',
        turnCount: 0,
        transcriptLines: [],
        customerName: null,
        customerPhone: from || 'unknown',
        pickupTime: null,
        items: [],
        unknownItems: [],
        awaitingConfirmation: false,
        restaurantId: restaurant.id,
        restaurantName: voiceConfig.brandName,
        strictMenuValidation: voiceConfig.strictMenuValidation,
        menuItems: normalizeMenu(restaurant.menu_json)
      };
    }
  }

  if (!state) {
    twiml.say({ voice: ASSISTANT_VOICE }, 'Your session expired. Please call again.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  state.turnCount += 1;
  state.customerPhone = from || state.customerPhone;

  if (!spoken) {
    if (state.turnCount >= MAX_TURNS) {
      await failCall(callSid, 'Call failed due to repeated no speech input.');
      twiml.say(
        { voice: ASSISTANT_VOICE },
        'Sorry, I still cannot hear you clearly. Please call again. Goodbye.'
      );
      twiml.hangup();
      return res.type('text/xml').send(twiml.toString());
    }

    await saveCallState(callSid, state);
    const retryUrl = buildUrl(req, '/twilio/converse', {
      restaurant_id: state.restaurantId,
      called,
      from,
      turn: String(state.turnCount + 1)
    });
    const gatherRetry = twiml.gather({
      input: ['speech'],
      speechTimeout: 'auto',
      method: 'POST',
      action: retryUrl
    });
    gatherRetry.say({ voice: ASSISTANT_VOICE }, 'I missed that. Please repeat your order details.');
    twiml.say({ voice: ASSISTANT_VOICE }, 'Still no response. Goodbye.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  state.transcriptLines.push(`Customer: ${spoken}`);

  if (state.awaitingConfirmation) {
    const confirmed = parseConfirmation(spoken);

    if (confirmed === 'yes') {
      await completeOrder(callSid, state);

      state.stage = 'COMPLETE';
      state.awaitingConfirmation = false;
      await saveCallState(callSid, state);

      twiml.say({ voice: ASSISTANT_VOICE }, confirmationClosing(state.customerName, state.pickupTime));
      twiml.hangup();
      return res.type('text/xml').send(twiml.toString());
    }

    state.awaitingConfirmation = false;
    state.transcriptLines.push('Assistant: Okay, let us update your order. Please tell me the correct details.');
  }

  const llmTurn = await runOrderTurn(callSid, state, spoken, state.menuItems);

  if (llmTurn.customer_name) state.customerName = llmTurn.customer_name;
  if (llmTurn.pickup_time) state.pickupTime = llmTurn.pickup_time;

  const validatedItems: ValidatedOrderItem[] = [];
  const unknown: string[] = [];

  for (const item of llmTurn.items) {
    const matched = findMenuMatch(item.name, state.menuItems);
    if (!matched && state.strictMenuValidation) {
      unknown.push(item.name);
      continue;
    }

    if (matched) {
      validatedItems.push({
        name: matched.name,
        quantity: Math.max(1, Number(item.quantity || 1)),
        unit_price: matched.basePrice,
        options: item.options ?? []
      });
    }
  }

  for (const u of llmTurn.unknown_items) {
    if (u && !unknown.includes(u)) unknown.push(u);
  }

  if (validatedItems.length > 0) state.items = validatedItems;
  state.unknownItems = unknown;

  state.stage = determineStage(state);

  let assistantReply = sanitizeSpeechReply(llmTurn.assistant_reply);

  if (unknown.length > 0) {
    const examples = state.menuItems.slice(0, 5).map((i) => i.name).join(', ');
    assistantReply = `Sorry, I could not find ${unknown.join(
      ', '
    )} on our menu. You can choose items like ${examples}. What would you like instead?`;
    state.stage = 'COLLECT_ITEMS';
  } else if (state.stage === 'COMPLETE') {
    assistantReply = friendlyConfirmReply(state);
    state.awaitingConfirmation = true;
    state.stage = 'CONFIRM_ORDER';
  }

  state.transcriptLines.push(`Assistant: ${assistantReply}`);
  console.log(
    `[call][${callSid}] assistant_reply=\"${assistantReply}\" stage=${state.stage} items=${JSON.stringify(
      state.items
    )} unknown=${JSON.stringify(state.unknownItems)}`
  );

  await supabaseAdmin.from('calls').upsert(
    {
      twilio_call_sid: callSid,
      restaurant_id: state.restaurantId,
      transcript: state.transcriptLines.join('\n'),
      status: 'in_progress'
    },
    { onConflict: 'twilio_call_sid' }
  );

  if (state.turnCount >= MAX_TURNS && !state.awaitingConfirmation) {
    await failCall(callSid, state.transcriptLines.join('\n'));
    twiml.say(
      { voice: ASSISTANT_VOICE },
      'I could not complete your order details right now. Please call again. Goodbye.'
    );
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  await saveCallState(callSid, state);

  const nextUrl = buildUrl(req, '/twilio/converse', {
    restaurant_id: state.restaurantId,
    called,
    from,
    turn: String(state.turnCount + 1)
  });

  const gather = twiml.gather({
    input: ['speech'],
    speechTimeout: 'auto',
    method: 'POST',
    action: nextUrl
  });
  gather.say({ voice: ASSISTANT_VOICE }, assistantReply);

  const retryLine = RETRY_LINES[(state.turnCount - 1) % RETRY_LINES.length];
  twiml.say({ voice: ASSISTANT_VOICE }, retryLine);
  twiml.hangup();
  return res.type('text/xml').send(twiml.toString());
});

router.post('/media-transcript', async (req, res) => {
  const internalKey = req.get('x-internal-api-key') ?? '';
  if (env.INTERNAL_API_KEY && internalKey !== env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'unauthorized internal request' });
  }

  const body = (req.body ?? {}) as MediaTranscriptBody;
  const callSid = toStringValue(body.callSid);
  const transcript = toStringValue(body.transcript);

  if (!callSid || !transcript) {
    return res.status(400).json({ error: 'callSid and transcript are required' });
  }

  const result = await processTranscriptTurn(callSid, transcript);
  return res.status(result.status).json(result.body);
});

router.post('/realtime-turn', async (req, res) => {
  const internalKey = req.get('x-internal-api-key') ?? '';
  if (env.INTERNAL_API_KEY && internalKey !== env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'unauthorized internal request' });
  }

  const body = (req.body ?? {}) as MediaTranscriptBody;
  const callSid = toStringValue(body.callSid);
  const transcript = toStringValue(body.transcript);
  if (!callSid || !transcript) {
    return res.status(400).json({ error: 'callSid and transcript are required' });
  }

  const result = await processTranscriptTurn(callSid, transcript);
  return res.status(result.status).json(result.body);
});

export default router;
