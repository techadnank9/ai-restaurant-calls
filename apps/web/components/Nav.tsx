'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { getSupabaseClient } from '../lib/supabase';

function linkClass(pathname: string, href: string) {
  return pathname.startsWith(href) ? 'nav-link nav-link-active' : 'nav-link';
}

export function Nav() {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <div className="nav">
      <Link className={linkClass(pathname, '/orders')} href="/orders">
        Orders
      </Link>
      <Link className={linkClass(pathname, '/calls')} href="/calls">
        Calls
      </Link>
      <Link className={linkClass(pathname, '/menu')} href="/menu">
        Menu
      </Link>
      <button
        className="nav-btn"
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
