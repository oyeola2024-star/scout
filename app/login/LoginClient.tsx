'use client';

import { FormEvent, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';

type Mode = 'login' | 'signup' | 'forgot';

function appOrigin() {
  const configured = String(process.env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return typeof window !== 'undefined' ? window.location.origin : '';
}

export default function LoginClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = useMemo(() => searchParams.get('next') || '/dashboard', [searchParams]);
  const [mode, setMode] = useState<Mode>('login');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    const supabase = createClient();

    try {
      if (mode === 'forgot') {
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${appOrigin()}/auth/callback?next=/reset-password`
        });
        if (resetError) throw resetError;
        setMessage('Password reset email sent. Check your inbox, then follow the link to create a new password.');
        return;
      }

      if (mode === 'login') {
        const { error: loginError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (loginError) throw loginError;
        router.replace(next);
        router.refresh();
        return;
      }

      const cleanName = fullName.trim().replace(/\s+/g, ' ');
      if (cleanName.length < 2) throw new Error('Enter your full name.');

      const { data, error: signupError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { full_name: cleanName, name: cleanName },
          emailRedirectTo: `${appOrigin()}/auth/callback?next=/dashboard`
        }
      });
      if (signupError) throw signupError;

      if (data.session) {
        setMessage('Account created. Opening your Scout workspace...');
        router.replace(next);
        router.refresh();
        return;
      }

      setMessage('Account created. Check your email to confirm your account, then sign in.');
      setMode('login');
      setPassword('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught || 'Request failed.'));
    } finally {
      setLoading(false);
    }
  }

  const title = mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Reset password';
  const subtitle = mode === 'forgot'
    ? 'Enter your email. Scout will send a reset link so you can create a new password.'
    : 'Private Scout account and workspace.';

  return (
    <main className="container" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
      <section className="card" style={{ width: '100%', maxWidth: 460, padding: 28 }}>
        <div className="brand" style={{ marginBottom: 24 }}>
          <div className="logo" />
          <div><h1>Scout App</h1><p>{subtitle}</p></div>
        </div>
        <form onSubmit={submit} className="stack">
          {mode === 'signup' ? (
            <div>
              <label className="label">Full name</label>
              <input className="input" type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} required minLength={2} maxLength={120} autoComplete="name" placeholder="Your full name" />
            </div>
          ) : null}
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </div>
          {mode !== 'forgot' ? (
            <div>
              <label className="label">Password</label>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
            </div>
          ) : null}
          {error ? <div className="error">{error}</div> : null}
          {message ? <div className="success">{message}</div> : null}
          <button className="btn" disabled={loading}>{loading ? 'Please wait...' : title}</button>
        </form>
        <div className="actions" style={{ marginTop: 16 }}>
          <button className="btn secondary" type="button" onClick={() => { setError(null); setMessage(null); setMode(mode === 'signup' || mode === 'forgot' ? 'login' : 'signup'); }}>
            {mode === 'login' ? 'Create new account' : 'Back to sign in'}
          </button>
          {mode === 'login' ? (
            <button className="btn secondary" type="button" onClick={() => { setError(null); setMessage(null); setMode('forgot'); }}>Forgot password?</button>
          ) : null}
        </div>
      </section>
    </main>
  );
}
