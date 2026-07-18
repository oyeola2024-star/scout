export default function AppLoading() {
  return (
    <div className="stack" style={{ padding: 24 }}>
      <div className="card" style={{ padding: 22 }}>
        <div className="actions" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0 }}>Loading Scout...</h2>
            <p className="muted" style={{ margin: '8px 0 0' }}>Getting the latest numbers for this page.</p>
          </div>
          <span className="badge">Please wait</span>
        </div>
      </div>
      <div className="grid grid-4">
        {[1, 2, 3, 4].map((item) => <div className="card kpi" key={item}><div className="title">Loading</div><div className="num">...</div></div>)}
      </div>
    </div>
  );
}
