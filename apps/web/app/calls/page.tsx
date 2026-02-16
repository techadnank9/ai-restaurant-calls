'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Nav } from '../../components/Nav';
import { apiFetch } from '../../lib/api';

type Call = {
  id: string;
  status: string;
  recording_url: string | null;
  created_at: string;
  duration_seconds: number | null;
};

export default function CallsPage() {
  const router = useRouter();
  const [calls, setCalls] = useState<Call[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch('/calls')
      .then((d) => setCalls(d.calls))
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
        <h2>Calls</h2>
        {error ? <p style={{ color: 'crimson' }}>{error}</p> : null}
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Recording</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id}>
                <td>{c.id.slice(0, 8)}</td>
                <td>{c.status}</td>
                <td>{c.duration_seconds ?? '-'}</td>
                <td>{c.recording_url ? <a href={c.recording_url}>Link</a> : '-'}</td>
                <td>{new Date(c.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
