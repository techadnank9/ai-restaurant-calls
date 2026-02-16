import { randomUUID } from 'node:crypto';
import { type NextFunction, type Request, type Response, Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase.js';
import { env } from '../lib/env.js';

const router = Router();

const toolAuth = (req: Request, res: Response, next: NextFunction) => {
  const key = req.get('x-internal-api-key') ?? '';
  if (env.INTERNAL_API_KEY && key !== env.INTERNAL_API_KEY) {
    res.status(401).json({ error: 'unauthorized internal request' });
    return;
  }
  next();
};

router.use(toolAuth);

type MenuItem = {
  name: string;
  price: number;
  aliases: string[];
};

const getMenuInputSchema = z.object({
  restaurant_id: z.string().uuid()
});

const checkAvailabilityInputSchema = z.object({
  restaurant_id: z.string().uuid(),
  date: z.string().min(4),
  time: z.string().min(2),
  party_size: z.number().int().positive()
});

const buildOrderInputSchema = z.object({
  restaurant_id: z.string().uuid(),
  customer_name: z.string().min(1).optional(),
  customer_phone: z.string().min(7),
  pickup_time: z.string().min(2),
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        quantity: z.number().int().positive(),
        options: z.array(z.object({ name: z.string().min(1), value: z.string().min(1) })).default([])
      })
    )
    .min(1),
  special_instructions: z.string().optional()
});

const createReservationInputSchema = z.object({
  restaurant_id: z.string().uuid(),
  customer_name: z.string().min(1),
  customer_phone: z.string().min(7),
  date: z.string().min(4),
  time: z.string().min(2),
  party_size: z.number().int().positive(),
  notes: z.string().optional()
});

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
      const name = String(item.name ?? '').trim();
      if (!name) continue;
      const price = Number(item.price ?? 0);
      const aliases = Array.isArray(item.aliases)
        ? item.aliases.map((a) => String(a ?? '').trim()).filter(Boolean)
        : [];
      output.push({ name, price: Number.isFinite(price) ? price : 0, aliases });
    }
  }

  return output;
}

function matchMenuItem(name: string, menuItems: MenuItem[]) {
  const target = normalizeKey(name);
  if (!target) return null;
  const exact = menuItems.find((item) => normalizeKey(item.name) === target);
  if (exact) return exact;
  return menuItems.find((item) => item.aliases.some((a) => normalizeKey(a) === target)) ?? null;
}

async function fetchRestaurant(restaurantId: string) {
  const { data: restaurant } = await supabaseAdmin
    .from('restaurants')
    .select('id, name, menu_json')
    .eq('id', restaurantId)
    .maybeSingle();
  return restaurant;
}

router.post('/get_menu', async (req, res) => {
  const parsed = getMenuInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const restaurant = await fetchRestaurant(parsed.data.restaurant_id);
  if (!restaurant?.id) return res.status(404).json({ error: 'restaurant not found' });

  const menuItems = normalizeMenu(restaurant.menu_json);
  return res.json({
    restaurant_id: restaurant.id,
    restaurant_name: restaurant.name,
    items: menuItems
  });
});

router.post('/check_availability', async (req, res) => {
  const parsed = checkAvailabilityInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const restaurant = await fetchRestaurant(parsed.data.restaurant_id);
  if (!restaurant?.id) return res.status(404).json({ error: 'restaurant not found' });

  // MVP default: reservation checks always available; can be replaced with business-hours logic.
  return res.json({
    available: true,
    date: parsed.data.date,
    time: parsed.data.time,
    party_size: parsed.data.party_size
  });
});

router.post('/build_order', async (req, res) => {
  const parsed = buildOrderInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const restaurant = await fetchRestaurant(parsed.data.restaurant_id);
  if (!restaurant?.id) return res.status(404).json({ error: 'restaurant not found' });
  const menuItems = normalizeMenu(restaurant.menu_json);

  const normalizedItems: Array<{
    name: string;
    quantity: number;
    unit_price: number;
    options: { name: string; value: string }[];
  }> = [];
  const unknown_items: string[] = [];

  for (const item of parsed.data.items) {
    const matched = matchMenuItem(item.name, menuItems);
    if (!matched) {
      unknown_items.push(item.name);
      continue;
    }
    normalizedItems.push({
      name: matched.name,
      quantity: item.quantity,
      unit_price: matched.price,
      options: item.options
    });
  }

  const total = normalizedItems.reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
  return res.json({
    valid: unknown_items.length === 0 && normalizedItems.length > 0,
    unknown_items,
    draft_order: {
      restaurant_id: parsed.data.restaurant_id,
      customer_name: parsed.data.customer_name ?? 'Unknown',
      customer_phone: parsed.data.customer_phone,
      pickup_time: parsed.data.pickup_time,
      items: normalizedItems,
      special_instructions: parsed.data.special_instructions ?? '',
      total_price: Number(total.toFixed(2))
    }
  });
});

router.post('/confirm_order', async (req, res) => {
  const parsed = buildOrderInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const restaurant = await fetchRestaurant(parsed.data.restaurant_id);
  if (!restaurant?.id) return res.status(404).json({ error: 'restaurant not found' });
  const menuItems = normalizeMenu(restaurant.menu_json);

  const normalizedItems: Array<{
    name: string;
    quantity: number;
    unit_price: number;
    options: { name: string; value: string }[];
  }> = [];
  const unknown_items: string[] = [];

  for (const item of parsed.data.items) {
    const matched = matchMenuItem(item.name, menuItems);
    if (!matched) {
      unknown_items.push(item.name);
      continue;
    }
    normalizedItems.push({
      name: matched.name,
      quantity: item.quantity,
      unit_price: matched.price,
      options: item.options
    });
  }

  if (unknown_items.length > 0 || normalizedItems.length === 0) {
    return res.status(400).json({ error: 'invalid menu items', unknown_items });
  }

  const total = normalizedItems.reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .insert({
      restaurant_id: parsed.data.restaurant_id,
      customer_name: parsed.data.customer_name ?? 'Unknown',
      customer_phone: parsed.data.customer_phone,
      items_json: normalizedItems,
      total_price: Number(total.toFixed(2)),
      pickup_time: parsed.data.pickup_time,
      status: 'pending',
      transcript: '[Deepgram Agent confirmed order]',
      ai_confidence: 0.95
    })
    .select('id')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ confirmed: true, order_id: order?.id ?? null });
});

router.post('/create_reservation', async (req, res) => {
  const parsed = createReservationInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const restaurant = await fetchRestaurant(parsed.data.restaurant_id);
  if (!restaurant?.id) return res.status(404).json({ error: 'restaurant not found' });

  const reservationId = randomUUID();
  const transcript = JSON.stringify({
    type: 'reservation',
    reservation_id: reservationId,
    customer_name: parsed.data.customer_name,
    customer_phone: parsed.data.customer_phone,
    date: parsed.data.date,
    time: parsed.data.time,
    party_size: parsed.data.party_size,
    notes: parsed.data.notes ?? ''
  });

  // MVP persistence without new migration: store reservation event in calls log.
  const { error } = await supabaseAdmin.from('calls').insert({
    twilio_call_sid: `reservation-${reservationId}`,
    restaurant_id: parsed.data.restaurant_id,
    status: 'completed',
    transcript
  });

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ created: true, reservation_id: reservationId });
});

export default router;
