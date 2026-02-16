'use client';

import { createSupabaseBrowserClient } from '@arc/supabase';

let supabaseClient: ReturnType<typeof createSupabaseBrowserClient> | null = null;

export function getSupabaseClient() {
  if (!supabaseClient) {
    const hasConfig =
      Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
      Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

    if (!hasConfig) {
      throw new Error('Missing Supabase env: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY');
    }

    supabaseClient = createSupabaseBrowserClient();
  }

  return supabaseClient;
}
