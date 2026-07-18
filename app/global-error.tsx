'use client';

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'Arial, sans-serif', background: '#0b1020', color: '#f8fafc' }}>
        <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
          <section style={{ width: '100%', maxWidth: 560, padding: 28, borderRadius: 18, background: '#111827', border: '1px solid #334155' }}>
            <h1 style={{ marginTop: 0 }}>Scout needs to reload</h1>
            <p style={{ color: '#cbd5e1', lineHeight: 1.6 }}>A temporary application error stopped the page. Your database records remain saved.</p>
            <button type="button" onClick={() => reset()} style={{ padding: '12px 16px', borderRadius: 10, border: 0, fontWeight: 800, cursor: 'pointer' }}>Try again</button>
          </section>
        </main>
      </body>
    </html>
  );
}
