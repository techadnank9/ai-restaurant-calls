'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getSupabaseClient } from '../../lib/supabase';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  return (
    <div className="card" style={{ maxWidth: 440, margin: '40px auto' }}>
      <h2>Restaurant Login</h2>
      <input className="input" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <div style={{ height: 12 }} />
      <input
        className="input"
        placeholder="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <div style={{ height: 12 }} />
      <button
        onClick={async () => {
          setError('');
          const { error: authError } = await getSupabaseClient().auth.signInWithPassword({ email, password });
          if (authError) {
            setError(authError.message);
            return;
          }
          router.push('/orders');
        }}
      >
        Sign in
      </button>
      {error ? <p style={{ color: 'crimson' }}>{error}</p> : null}
    </div>
  );
}
