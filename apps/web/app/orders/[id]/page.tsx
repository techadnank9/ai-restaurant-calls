'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Nav } from '../../../components/Nav';
import { apiFetch } from '../../../lib/api';

type OrderItem = {
  name?: string;
  quantity?: number;
  unit_price?: number;
  options?: { name: string; value: string }[];
};

type Order = {
  id: string;
  customer_name?: string | null;
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
  if (order.customer_name && order.customer_name.trim()) return order.customer_name.trim();
  const transcript = order.transcript ?? '';
  const nameMatch =
    transcript.match(/\bmy name is\s+([a-z][a-z\s'-]{1,40})\b/i) ??
    transcript.match(/\bname is\s+([a-z][a-z\s'-]{1,40})\b/i);

  if (nameMatch?.[1]) return nameMatch[1].trim();
  return 'Unknown';
}

export default function OrderDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [order, setOrder] = useState<Order | null>(null);
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
        <h2>Order Details</h2>
        {error ? <p style={{ color: 'crimson' }}>{error}</p> : null}
        {!error && !order ? <p className="muted">Loading order...</p> : null}
        {order ? (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              <Link href="/orders">Back to Orders</Link>
            </p>
            <div className="meta-grid">
              <div className="meta-item">
                <p className="meta-label">Order ID</p>
                <p className="meta-value">{order.id}</p>
              </div>
              <div className="meta-item">
                <p className="meta-label">Date</p>
                <p className="meta-value">{formatDate(order.created_at)}</p>
              </div>
              <div className="meta-item">
                <p className="meta-label">Time</p>
                <p className="meta-value">{formatTime(order.created_at)}</p>
              </div>
              <div className="meta-item">
                <p className="meta-label">Customer</p>
                <p className="meta-value">{customerName(order)}</p>
              </div>
              <div className="meta-item">
                <p className="meta-label">Phone</p>
                <p className="meta-value">{order.customer_phone || '-'}</p>
              </div>
              <div className="meta-item">
                <p className="meta-label">Amount</p>
                <p className="meta-value">${Number(order.total_price).toFixed(2)}</p>
              </div>
              <div className="meta-item">
                <p className="meta-label">Order Type</p>
                <p className="meta-value">Pickup</p>
              </div>
              <div className="meta-item">
                <p className="meta-label">Pickup Time</p>
                <p className="meta-value">{order.pickup_time}</p>
              </div>
              <div className="meta-item">
                <p className="meta-label">Status</p>
                <p className="meta-value">
                  <span className="badge">{order.status}</span>
                </p>
              </div>
            </div>

            <h3>Items</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Qty</th>
                  <th>Unit Price</th>
                </tr>
              </thead>
              <tbody>
                {(order.items_json ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={3} className="muted">
                      No parsed items.
                    </td>
                  </tr>
                ) : null}
                {(order.items_json ?? []).map((item, index) => (
                  <tr key={`${item.name ?? 'item'}-${index}`}>
                    <td>{item.name ?? 'Item'}</td>
                    <td>{item.quantity ?? 1}</td>
                    <td>${Number(item.unit_price ?? 0).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>Transcript</h3>
            <p>{order.transcript || 'No transcript available.'}</p>
          </>
        ) : null}
      </div>
    </>
  );
}
