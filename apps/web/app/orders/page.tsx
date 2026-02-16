'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Nav } from '../../components/Nav';
import { apiFetch } from '../../lib/api';

type Order = {
  id: string;
  customer_phone: string;
  total_price: number;
  pickup_time: string;
  status: string;
  created_at: string;
};

export default function OrdersPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch('/orders')
      .then((d) => setOrders(d.orders))
      .catch((e) => {
        const message = String(e.message ?? '');
        if (message.includes('AUTH_REQUIRED') || message.includes('Missing bearer token')) {
          router.push('/login');
          return;
        }
        setError(message);
      });
  }, [router]);

  return (
    <>
      <Nav />
      <div className="card">
        <h2>Orders</h2>
        {error ? <p style={{ color: 'crimson' }}>{error}</p> : null}
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Phone</th>
              <th>Total</th>
              <th>Pickup</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>
                  <Link href={`/orders/${o.id}`}>{o.id.slice(0, 8)}</Link>
                </td>
                <td>{o.customer_phone}</td>
                <td>${Number(o.total_price).toFixed(2)}</td>
                <td>{o.pickup_time}</td>
                <td>{o.status}</td>
                <td>{new Date(o.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
