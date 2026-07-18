'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

export default function ResetPasswordClient() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    async function prepareSession() {
      try {
        const supabase = createClient();
        const url = new URL(window.location.href);
        const linkError = url.searchParams.get('error');
        if (linkError) throw new Error(linkError);
        const code = url.searchParams.get('code');
        if (code) {
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
          if (exchangeError) throw exchangeError;
          window.history.replaceState({}, document.title, '/reset-password');
        }
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        if (!session) throw new Error('This reset link is invalid or expired. Request a new password-reset email from Scout.');
        if (mounted) setReady(true);
      } catch (caught) {
        if (mounted) setError(caught instanceof Error ? caught.message : 'Scout could not open this reset link.');
      } finally {
        if (mounted) setChecking(false);
      }
    }
    void prepareSession();
    return () => { mounted = false; };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (updateError) {
      setError(updateError.message || 'Could not update password. Open the latest reset link from your email and try again.');
      return;
    }

    setMessage('Password updated. You can now sign in with your new password.');
    await supabase.auth.signOut();
    setTimeout(() => {
      router.replace('/login');
      router.refresh();
    }, 1200);
  }

  return (
    <main className="container" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
      <section className="card" style={{ width: '100%', maxWidth: 460, padding: 28 }}>
        <div className="brand" style={{ marginBottom: 24 }}>
          <div className="logo" />
          <div>
            <h1>Create new password</h1>
            <p>Enter and confirm your new Scout password.</p>
          </div>
        </div>
        {checking ? <div className="notice">Checking your password-reset link...</div> : null}
        {!checking && !ready && error ? <div className="actions"><button className="btn secondary" type="button" onClick={() => router.replace('/login')}>Return to login</button></div> : null}
        {ready ? <form onSubmit={submit} className="stack">
          <div>
            <label className="label">New password</label>
            <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} autoComplete="new-password" />
          </div>
          <div>
            <label className="label">Confirm new password</label>
            <input className="input" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required minLength={8} autoComplete="new-password" />
          </div>
          {error ? <div className="error">{error}</div> : null}
          {message ? <div className="success">{message}</div> : null}
          <button className="btn" disabled={loading}>{loading ? 'Saving...' : 'Save new password'}</button>
        </form> : null}
      </section>
    </main>
  );
}
