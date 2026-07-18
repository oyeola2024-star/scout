'use client';

import { Trophy } from 'lucide-react';
import { useEffect, useState } from 'react';

type LevelStage = { name: string; stageNumber: number; unlocked: boolean };

type LevelData = {
  success?: boolean;
  points?: number;
  stageNumber?: number;
  totalStages?: number;
  progress?: number;
  current?: { name: string; min: number };
  next?: { name: string; min: number } | null;
  stages?: LevelStage[];
  hints?: string[];
  highlights?: Record<string, number>;
};

export function ScoutingLevel({ workspaceId }: { workspaceId?: string | null }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<LevelData | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    async function load() {
      const response = await fetch(`/api/scouting-level?workspaceId=${encodeURIComponent(workspaceId || '')}`, { cache: 'no-store' });
      const json = await response.json().catch(() => ({}));
      if (alive) setData(json);
    }
    const initial = window.setTimeout(() => load().catch(() => {}), 18000);
    const timer = window.setInterval(() => load().catch(() => {}), 300_000);
    return () => { alive = false; window.clearTimeout(initial); window.clearInterval(timer); };
  }, [workspaceId]);

  if (!workspaceId) return null;
  const stageName = data?.current?.name || 'Novice';
  const progress = Number(data?.progress || 0);
  const highlights = data?.highlights || {};
  const stages = data?.stages || [
    'Novice', 'Rookie', 'Apprentice', 'Scout', 'Pro Scout', 'Strategist', 'Operator', 'Rainmaker', 'Commander', 'Master Scout', 'Grandmaster', 'Ultimate'
  ].map((name, index) => ({ name, stageNumber: index + 1, unlocked: index === 0 }));
  const hints = data?.hints?.length ? data.hints : [
    'Keep finding trusted emails, sending clean messages, and earning replies.',
    'Prospect replies and replies sent from Scout move your mastery fastest.'
  ];

  return (
    <div className="scouting-level-wrap">
      <button className="scouting-level-button" type="button" onClick={() => setOpen((current) => !current)}>
        <Trophy size={17} />
        <span>
          <strong>Scouting Level</strong>
          <small>{stageName} · {progress}%</small>
        </span>
      </button>
      {open ? (
        <div className="scouting-level-card">
          <div className="actions" style={{ justifyContent: 'space-between' }}>
            <div>
              <h3 style={{ margin: 0 }}>{stageName}</h3>
              <p className="muted" style={{ margin: '4px 0 0' }}>Stage {data?.stageNumber || 1} of {data?.totalStages || 12}</p>
            </div>
            <button className="btn secondary mini" type="button" onClick={() => setOpen(false)}>Close</button>
          </div>
          <div className="progress-track" style={{ marginTop: 12 }}><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
          <p className="muted" style={{ fontSize: 12 }}>You can see the level ladder, but the exact score needed for the next stage is hidden. Use the hints below and keep doing real scouting work.</p>

          <div className="level-stage-list" aria-label="Scouting level ladder">
            {stages.map((stage) => (
              <span key={stage.name} className={`level-stage-pill ${stage.unlocked ? 'unlocked' : 'locked'} ${stage.name === stageName ? 'current' : ''}`}>
                <strong>{stage.stageNumber}</strong>
                {stage.unlocked ? '✓' : '🔒'} {stage.name}
              </span>
            ))}
          </div>

          <div className="level-hint-box">
            <strong>Hints to grow faster</strong>
            <ul>
              {hints.slice(0, 4).map((hint) => <li key={hint}>{hint}</li>)}
            </ul>
          </div>

          <div className="level-mini-grid">
            <span>Messages <strong>{Number(highlights.deliveredMessages || 0).toLocaleString()}</strong></span>
            <span>Trusted emails <strong>{Number(highlights.trustedEmails || 0).toLocaleString()}</strong></span>
            <span>Replies <strong>{Number(highlights.realReplies || 0).toLocaleString()}</strong></span>
            <span>Your replies <strong>{Number(highlights.manualReplies || 0).toLocaleString()}</strong></span>
          </div>
          <p className="muted" style={{ fontSize: 11, marginBottom: 0 }}>Easy actions help. Replies and thoughtful replies from Scout help the most. Later stages are intentionally very hard.</p>
        </div>
      ) : null}
    </div>
  );
}
