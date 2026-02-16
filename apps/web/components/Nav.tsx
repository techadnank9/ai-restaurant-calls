'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getSupabaseClient } from '../lib/supabase';

export function Nav() {
  const router = useRouter();

  return (
    <div className="nav">
      <Link href="/orders">Orders</Link>
      <Link href="/calls">Calls</Link>
      <Link href="/menu">Menu</Link>
      <button
        onClick={async () => {
          await getSupabaseClient().auth.signOut();
          router.push('/login');
        }}
      >
        Logout
      </button>
    </div>
  );
}
