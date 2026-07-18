'use client';

import { useEffect } from 'react';

export default function MessageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('Scout Message page error:', error); }, [error]);
  return (
    <div className="card stack" style={{ padding: 24, maxWidth: 720, margin: '32px auto' }}>
      <h2>Messages paused safely</h2>
      <p className="muted">Scout stopped the page view instead of repeating or losing a send. Any message already accepted by Gmail remains recorded by the durable job.</p>
      <div className="actions">
        <button className="btn" type="button" onClick={reset}>Reopen Messages</button>
        <a className="btn secondary" href="/dashboard">Go to dashboard</a>
      </div>
      {error?.message ? <p className="error" style={{ whiteSpace: 'pre-wrap' }}>{error.message}</p> : null}
    </div>
  );
}
