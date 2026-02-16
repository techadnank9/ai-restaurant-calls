'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Nav } from '../../components/Nav';
import { apiFetch } from '../../lib/api';

export default function MenuPage() {
  const router = useRouter();
  const [menuText, setMenuText] = useState('{\n  "categories": []\n}');
  const [message, setMessage] = useState('');

  useEffect(() => {
    apiFetch('/menu')
      .then((d) => {
        setMenuText(JSON.stringify(d.restaurant.menu_json ?? { categories: [] }, null, 2));
      })
      .catch((e) => {
        const msg = String(e.message ?? '');
        if (msg.includes('AUTH_REQUIRED') || msg.includes('Missing bearer token')) {
          router.push('/login');
          return;
        }
        setMessage(msg);
      });
  }, [router]);

  return (
    <>
      <Nav />
      <div className="card">
        <h2>Menu Editor</h2>
        <textarea rows={20} value={menuText} onChange={(e) => setMenuText(e.target.value)} />
        <div style={{ height: 12 }} />
        <button
          onClick={async () => {
            setMessage('');
            try {
              const parsed = JSON.parse(menuText);
              await apiFetch('/menu', {
                method: 'PUT',
                body: JSON.stringify({ menu_json: parsed })
              });
              setMessage('Saved');
            } catch (e) {
              setMessage((e as Error).message);
            }
          }}
        >
          Save Menu
        </button>
        {message ? <p>{message}</p> : null}
      </div>
    </>
  );
}
