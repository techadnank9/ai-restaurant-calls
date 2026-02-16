import { Router } from 'express';
import { requireSupabaseAuth, type AuthedRequest } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';

const router = Router();

router.get('/', requireSupabaseAuth, async (req: AuthedRequest, res) => {
  const { data, error } = await supabaseAdmin
    .from('calls')
    .select('*')
    .eq('restaurant_id', req.restaurantId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ calls: data });
});

export default router;
