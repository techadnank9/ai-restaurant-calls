import { NextFunction, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';

type AuthUser = {
  id: string;
  email?: string;
};

export type AuthedRequest = Request & {
  user?: AuthUser;
  restaurantId?: string;
};

export async function requireSupabaseAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  const token = header.slice(7);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const { data: membership, error: membershipError } = await supabaseAdmin
    .from('restaurant_users')
    .select('restaurant_id')
    .eq('user_id', data.user.id)
    .limit(1)
    .maybeSingle();

  if (membershipError || !membership) {
    return res.status(403).json({ error: 'No restaurant access' });
  }

  req.user = { id: data.user.id, email: data.user.email };
  req.restaurantId = membership.restaurant_id;
  next();
}
