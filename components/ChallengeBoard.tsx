'use client';

import { useMemo, useState } from 'react';
type Challenge = {
  id: string;
  icon: string;
  title: string;
  metric: string;
  target: number;
  tier?: 'Starter' | 'Growth' | 'Boss' | 'Legend';
  steps: string[];
};

type Props = {
  challenges: Challenge[];
  metrics: Record<string, number>;
};

const tierOrder = ['Starter', 'Growth', 'Boss', 'Legend'];

function percent(value: number, target: number) {
  if (!target) return 0;
  return Math.max(0, Math.min(100, Math.round((value / target) * 100)));
}

function tierLabel(item: Challenge) {
  return item.tier || 'Growth';
}

function tierClass(tier: string) {
  return `challenge-tier challenge-tier-${tier.toLowerCase()}`;
}

export default function ChallengeBoard({ challenges, metrics }: Props) {
  const [selected, setSelected] = useState<Challenge | null>(null);
  const completed = useMemo(() => challenges.filter((item) => Number(metrics[item.metric] || 0) >= item.target).length, [challenges, metrics]);
  const next = useMemo(() => {
    return challenges
      .filter((item) => Number(metrics[item.metric] || 0) < item.target)
      .sort((a, b) => {
        const ap = percent(Number(metrics[a.metric] || 0), a.target);
        const bp = percent(Number(metrics[b.metric] || 0), b.target);
        if (bp !== ap) return bp - ap;
        return a.target - b.target;
      })
      .slice(0, 8);
  }, [challenges, metrics]);
  const grouped = useMemo(() => {
    const map = new Map<string, Challenge[]>();
    for (const tier of tierOrder) map.set(tier, []);
    for (const item of challenges) map.get(tierLabel(item))?.push(item);
    return tierOrder.map((tier) => ({ tier, items: map.get(tier) || [] })).filter((group) => group.items.length);
  }, [challenges]);

  return (
    <div className="stack">
      <div className="topbar">
        <div className="page-title">
          <h2>Challenges</h2>
          <p>Big goals that guide your outreach. A few are quick wins; most are stretch goals that should take days, weeks, or months.</p>
        </div>
        <span className="badge">{completed.toLocaleString()} / {challenges.length.toLocaleString()} complete</span>
      </div>

      <div className="grid grid-4">
        <div className="card kpi"><div className="title">Delivered messages</div><div className="num">{Number(metrics.deliveredMessages || 0).toLocaleString()}</div></div>
        <div className="card kpi"><div className="title">Trusted emails</div><div className="num">{Number(metrics.trustedEmails || 0).toLocaleString()}</div></div>
        <div className="card kpi"><div className="title">Replies</div><div className="num">{Number(metrics.realReplies || 0).toLocaleString()}</div></div>
        <div className="card kpi"><div className="title">Replies you sent</div><div className="num">{Number(metrics.manualReplies || 0).toLocaleString()}</div></div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Next best challenges</h3>
        <p className="muted">These are the closest unfinished goals. Click any card to see the simple steps.</p>
        <div className="challenge-grid" style={{ marginTop: 12 }}>
          {next.map((item) => {
            const value = Number(metrics[item.metric] || 0);
            return (
              <button className="challenge-card" key={item.id} type="button" onClick={() => setSelected(item)}>
                <span className="challenge-icon">{item.icon}</span>
                <span className={tierClass(tierLabel(item))}>{tierLabel(item)}</span>
                <strong>{item.title}</strong>
                <small>{value.toLocaleString()} / {item.target.toLocaleString()}</small>
                <div className="progress-track slim"><div className="progress-fill" style={{ width: `${percent(value, item.target)}%` }} /></div>
              </button>
            );
          })}
        </div>
      </div>

      {grouped.map((group) => (
        <div className="card" style={{ padding: 18 }} key={group.tier}>
          <div className="actions" style={{ justifyContent: 'space-between' }}>
            <div>
              <h3>{group.tier} challenges</h3>
              <p className="muted" style={{ marginTop: -4 }}>
                {group.tier === 'Starter' ? 'Quick wins to help you learn Scout.' : null}
                {group.tier === 'Growth' ? 'Goals for consistent daily outreach.' : null}
                {group.tier === 'Boss' ? 'Hard goals for serious scale.' : null}
                {group.tier === 'Legend' ? 'Huge goals that should take serious time and volume.' : null}
              </p>
            </div>
            <span className="badge">{group.items.filter((item) => Number(metrics[item.metric] || 0) >= item.target).length} / {group.items.length}</span>
          </div>
          <div className="challenge-grid">
            {group.items.map((item) => {
              const value = Number(metrics[item.metric] || 0);
              const done = value >= item.target;
              return (
                <button className={`challenge-card ${done ? 'done' : ''}`} key={item.id} type="button" onClick={() => setSelected(item)}>
                  <span className="challenge-icon">{item.icon}</span>
                  <span className={tierClass(tierLabel(item))}>{tierLabel(item)}</span>
                  <strong>{done ? '✓ ' : ''}{item.title}</strong>
                  <small>{value.toLocaleString()} / {item.target.toLocaleString()}</small>
                  <div className="progress-track slim"><div className="progress-fill" style={{ width: `${percent(value, item.target)}%` }} /></div>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {selected ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setSelected(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="actions" style={{ justifyContent: 'space-between' }}>
              <div>
                <div className="challenge-icon big">{selected.icon}</div>
                <span className={tierClass(tierLabel(selected))}>{tierLabel(selected)}</span>
                <h3 style={{ margin: '8px 0 0' }}>{selected.title}</h3>
                <p className="muted">Current: {Number(metrics[selected.metric] || 0).toLocaleString()} / {selected.target.toLocaleString()}</p>
              </div>
              <button className="btn secondary mini" type="button" onClick={() => setSelected(null)}>Close</button>
            </div>
            <ol className="simple-steps">
              {selected.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
          </div>
        </div>
      ) : null}
    </div>
  );
}
