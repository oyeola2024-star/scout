export default function NotFound() {
  return (
    <main className="container" style={{ minHeight: '70vh', display: 'grid', placeItems: 'center' }}>
      <section className="card stack" style={{ width: '100%', maxWidth: 560, padding: 28 }}>
        <div>
          <h2>Page not found</h2>
          <p className="muted">This Scout page may have moved, or the link is incomplete.</p>
        </div>
        <div className="actions"><a className="btn" href="/dashboard">Return to dashboard</a></div>
      </section>
    </main>
  );
}
