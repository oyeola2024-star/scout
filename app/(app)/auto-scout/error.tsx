'use client';

export default function AutoScoutError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card" style={{ padding: 24, maxWidth: 720, margin: '48px auto' }}>
      <h2>Auto Scout needs a refresh</h2>
      <p className="muted">The page hit a temporary problem while checking websites. Your leads are safe. Click Reload Auto Scout to reopen the page.</p>
      <pre className="error" style={{ whiteSpace: 'pre-wrap' }}>{error?.message || 'Unknown page error'}</pre>
      <button className="btn" onClick={reset}>Reload Auto Scout</button>
    </div>
  );
}
