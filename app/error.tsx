'use client';

import { useEffect } from 'react';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('Scout page error:', error);
  }, [error]);

  return (
    <main className="container" style={{ minHeight: '70vh', display: 'grid', placeItems: 'center' }}>
      <section className="card stack" style={{ width: '100%', maxWidth: 620, padding: 28 }}>
        <div>
          <h2 style={{ marginBottom: 8 }}>Scout could not finish loading this page</h2>
          <p className="muted">Your saved data was not deleted. This can happen after a temporary network or Supabase interruption.</p>
        </div>
        <div className="actions">
          <button className="btn" type="button" onClick={() => reset()}>Try again</button>
          <button className="btn secondary" type="button" onClick={() => window.location.reload()}>Reload Scout</button>
          <a className="btn secondary" href="/dashboard">Go to dashboard</a>
        </div>
        {error.digest ? <p className="muted" style={{ fontSize: 12 }}>Reference: {error.digest}</p> : null}
      </section>
    </main>
  );
}
