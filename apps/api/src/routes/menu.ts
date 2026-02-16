import { Router } from 'express';
import { updateMenuSchema } from '@arc/shared';
import { requireSupabaseAuth, type AuthedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';

const router = Router();

router.get('/', requireSupabaseAuth, async (req: AuthedRequest, res) => {
  const { data, error } = await supabaseAdmin
    .from('restaurants')
    .select('id, name, menu_json')
    .eq('id', req.restaurantId)
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ restaurant: data });
});

router.put('/', requireSupabaseAuth, async (req: AuthedRequest, res) => {
  const parsed = updateMenuSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { data, error } = await supabaseAdmin
    .from('restaurants')
    .update({ menu_json: parsed.data.menu_json })
    .eq('id', req.restaurantId)
    .select('id, menu_json')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ restaurant: data });
});

export default router;
