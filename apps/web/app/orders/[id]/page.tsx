'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Nav } from '../../../components/Nav';
import { apiFetch } from '../../../lib/api';

export default function OrderDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [order, setOrder] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch(`/orders/${params.id}`)
      .then((d) => setOrder(d.order))
      .catch((e) => {
        const message = String(e.message ?? '');
        if (message.includes('AUTH_REQUIRED') || message.includes('Missing bearer token')) {
          router.push('/login');
          return;
        }
        setError(message);
      });
  }, [params.id, router]);

  return (
    <>
      <Nav />
      <div className="card">
        <h2>Order Detail</h2>
        {error ? <p style={{ color: 'crimson' }}>{error}</p> : null}
        <pre>{JSON.stringify(order, null, 2)}</pre>
      </div>
    </>
  );
}
