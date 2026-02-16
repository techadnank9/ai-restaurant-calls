'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Nav } from '../../components/Nav';
import { apiFetch } from '../../lib/api';

type OrderItem = {
  name?: string;
  quantity?: number;
  unit_price?: number;
};

type Order = {
  id: string;
  customer_phone: string;
  total_price: number;
  pickup_time: string;
  status: string;
  created_at: string;
  transcript?: string | null;
  items_json?: OrderItem[] | null;
};

function formatDate(value: string) {
  return new Date(value).toLocaleDateString();
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function customerName(order: Order) {
  const transcript = order.transcript ?? '';
  const nameMatch =
    transcript.match(/\bmy name is\s+([a-z][a-z\s'-]{1,40})\b/i) ??
    transcript.match(/\bname is\s+([a-z][a-z\s'-]{1,40})\b/i);

  if (nameMatch?.[1]) return nameMatch[1].trim();
  return 'Unknown';
}

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
              <th>Order ID</th>
              <th>Date</th>
              <th>Time</th>
              <th>Customer Name</th>
              <th>Phone</th>
              <th>Amount</th>
              <th>Order Type</th>
              <th>Status</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 ? (
              <tr>
                <td colSpan={9} className="muted">
                  No orders yet.
                </td>
              </tr>
            ) : null}
            {orders.map((o) => (
              <tr key={o.id}>
                <td className="mono">{o.id.slice(0, 8)}</td>
                <td>{formatDate(o.created_at)}</td>
                <td>{formatTime(o.created_at)}</td>
                <td>{customerName(o)}</td>
                <td>{o.customer_phone || '-'}</td>
                <td>${Number(o.total_price).toFixed(2)}</td>
                <td>Pickup</td>
                <td>
                  <span className="badge">{o.status}</span>
                </td>
                <td>
                  <Link className="link-btn" href={`/orders/${o.id}`}>
                    View
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
