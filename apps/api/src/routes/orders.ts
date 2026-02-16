import { Router } from 'express';
import { createOrderBodySchema } from '@arc/shared';
import { requireSupabaseAuth, type AuthedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';

const router = Router();

router.get('/', requireSupabaseAuth, async (req: AuthedRequest, res) => {
  const { data, error } = await supabaseAdmin
    .from('orders')
    .select('*')
    .eq('restaurant_id', req.restaurantId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ orders: data });
});

router.get('/:id', requireSupabaseAuth, async (req: AuthedRequest, res) => {
  const { data, error } = await supabaseAdmin
    .from('orders')
    .select('*')
    .eq('id', req.params.id)
    .eq('restaurant_id', req.restaurantId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Not found' });
  res.json({ order: data });
});

router.post('/', requireSupabaseAuth, async (req: AuthedRequest, res) => {
  const parsed = createOrderBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  if (parsed.data.restaurant_id !== req.restaurantId) {
    return res.status(403).json({ error: 'Restaurant mismatch' });
  }

  const ai = parsed.data.ai_output;
  const { data, error } = await supabaseAdmin
    .from('orders')
    .insert({
      restaurant_id: parsed.data.restaurant_id,
      customer_phone: ai.customer_phone,
      items_json: ai.items,
      total_price: ai.total,
      pickup_time: ai.pickup_time,
      status: 'pending',
      transcript: parsed.data.transcript,
      ai_confidence: ai.confidence
    })
    .select('*')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ order: data });
});

export default router;
