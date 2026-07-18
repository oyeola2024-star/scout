'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, PauseCircle, RefreshCw, Send, Search, XCircle } from 'lucide-react';
import type { ScoutLiveActivityEvent } from '@/lib/live-activity-client';

type LiveSchedule = {
  id: string;
  type?: string | null;
  status?: string | null;
  run_kind?: string | null;
  target_count?: number | null;
  processed_count?: number | null;
  sent_count?: number | null;
  failed_count?: number | null;
  skipped_count?: number | null;
  scheduled_for?: string | null;
  updated_at?: string | null;
  last_heartbeat_at?: string | null;
  stop_requested?: boolean | null;
  last_error?: string | null;
};

type LiveResearch = {
  id: string;
  status?: string | null;
  attempts?: number | null;
  last_error?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  finished_at?: string | null;
};

type LivePayload = {
  success?: boolean;
  error?: string;
  schedules?: LiveSchedule[];
  researchJobs?: LiveResearch[];
  liveEvents?: ScoutLiveActivityEvent[];
  checkedAt?: string;
};

function fmtTime(value?: string | null) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function pct(schedule: LiveSchedule) {
  const total = Number(schedule.target_count || 0);
  const done = Number(schedule.processed_count || schedule.sent_count || 0);
  if (!total || total < 1) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function shortEmail(value?: string | null) {
  const email = String(value || '');
  if (email.length <= 32) return email;
  const [name, domain] = email.split('@');
  return `${name.slice(0, 12)}…@${domain || ''}`;
}

function eventKey(event: ScoutLiveActivityEvent) {
  return String(event.id || `${event.kind}:${event.status}:${event.message}:${event.createdAt}`);
}

function eventClass(status?: string) {
  const text = String(status || '').toLowerCase();
  if (text.includes('fail') || text.includes('blocked') || text.includes('limit')) return 'danger';
  if (text.includes('sent') || text.includes('found') || text.includes('complete')) return 'ok';
  if (text.includes('sending') || text.includes('checking') || text.includes('running')) return 'active';
  return 'neutral';
}

function eventLabel(event: ScoutLiveActivityEvent) {
  const status = String(event.status || '').replaceAll('_', ' ');
  if (event.title) return event.title;
  if (event.kind === 'auto_scout') return 'Auto Scout';
  if (status) return status;
  return 'Live update';
}

export function LiveActivityWindow({ workspaceId }: { workspaceId?: string | null }) {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<LivePayload>({});
  const [localEvents, setLocalEvents] = useState<ScoutLiveActivityEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [stopId, setStopId] = useState('');
  const [notificationPermission, setNotificationPermission] = useState<string>('unsupported');
  const lastNotifiedEventId = useRef<string>('');
  const loadingRef = useRef(false);

  const runningSchedules = useMemo(() => {
    const now = Date.now();
    return (payload.schedules || []).filter((row) => {
      const status = String(row.status || '');
      if (status === 'running' || status === 'due') return true;
      const scheduledFor = row.scheduled_for ? new Date(row.scheduled_for).getTime() : 0;
      return status === 'scheduled' && scheduledFor > 0 && scheduledFor <= now + 60_000;
    });
  }, [payload.schedules]);

  const runningResearch = useMemo(() => (payload.researchJobs || []).filter((row) => ['running', 'queued'].includes(String(row.status || ''))), [payload.researchJobs]);

  const liveEvents = useMemo(() => {
    const cutoff = Date.now() - 20 * 60 * 1000;
    const merged = [...localEvents, ...(payload.liveEvents || [])]
      .filter((event) => {
        const t = event.createdAt ? new Date(event.createdAt).getTime() : Date.now();
        return !Number.isNaN(t) && t >= cutoff;
      })
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    const seen = new Set<string>();
    const unique: ScoutLiveActivityEvent[] = [];
    for (const event of merged) {
      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(event);
    }
    return unique.slice(0, 40);
  }, [localEvents, payload.liveEvents]);

  const hasActiveLiveEvent = liveEvents.some((event) => ['sending', 'checking', 'running', 'worker_running', 'queueing'].some((word) => String(event.status || '').toLowerCase().includes(word)));
  const hasWork = runningSchedules.length > 0 || runningResearch.some((row) => row.status === 'running') || hasActiveLiveEvent;

  async function load() {
    if (!workspaceId || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const response = await fetch(`/api/activity/live?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: 'no-store' });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false) throw new Error(json?.error || `Activity check failed with HTTP ${response.status}`);
      setPayload(json);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }

  async function stopSchedule(scheduleId: string) {
    if (!workspaceId) return;
    setStopId(scheduleId);
    try {
      const response = await fetch('/api/message/stop-schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, scheduleId })
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false) throw new Error(json?.error || `Stop failed with HTTP ${response.status}`);
      setLocalEvents((current) => [{ id: `stop_${Date.now()}`, kind: 'schedule' as const, status: 'stopping', title: 'Stopping job', message: 'Stop requested. Current in-flight email may finish first.', createdAt: new Date().toISOString() }, ...current].slice(0, 80));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopId('');
    }
  }

  async function enableNotifications() {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setNotificationPermission('unsupported');
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
  }

  function notify(title: string, body: string) {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    const n = new Notification(title, { body, icon: '/icon-192.png', tag: 'scout-live-work' });
    n.onclick = () => {
      window.focus();
      window.location.href = '/message';
    };
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setNotificationPermission('Notification' in window ? Notification.permission : 'unsupported');
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ScoutLiveActivityEvent>).detail;
      if (!detail) return;
      const normalized = { ...detail, createdAt: detail.createdAt || new Date().toISOString() };
      setLocalEvents((current) => [normalized, ...current].slice(0, 100));
      setOpen(true);
    };
    window.addEventListener('scout-live-activity', handler as EventListener);
    return () => window.removeEventListener('scout-live-activity', handler as EventListener);
  }, []);

  useEffect(() => {
    const latest = liveEvents[0];
    const latestId = latest ? eventKey(latest) : '';
    if (latest && latestId && latestId !== lastNotifiedEventId.current) {
      if (lastNotifiedEventId.current) notify(eventLabel(latest), latest.message || latest.toEmail || latest.businessName || 'Scout is working');
      lastNotifiedEventId.current = latestId;
    }
  }, [liveEvents]);

  useEffect(() => {
    const initial = window.setTimeout(() => load(), open ? 1200 : 12000);
    const timer = window.setInterval(load, open ? 5000 : hasWork ? 10000 : 45000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, open, hasWork]);

  if (!workspaceId) return null;

  return (
    <div className={`live-activity ${open ? 'open' : ''}`}>
      <button className="live-activity-tab" type="button" onClick={() => setOpen((value) => !value)}>
        {loading || hasWork ? <Loader2 size={15} className="spin" /> : <span className="live-dot" />}
        <span>{open ? 'Hide live work' : (hasWork ? 'Working now' : 'Live work')}</span>
      </button>
      {open ? (
        <div className="live-activity-panel">
          <div className="live-activity-head">
            <div>
              <strong>Live work</strong>
              <p>Current sending and Auto Scout actions only. Old history is hidden.</p>
            </div>
            <div className="actions" style={{ gap: 6 }}>
              {notificationPermission !== 'granted' ? (
                <button className="btn secondary mini" type="button" onClick={enableNotifications} title="Enable desktop notifications">
                  Notify me
                </button>
              ) : null}
              <button className="icon-btn" type="button" onClick={load} disabled={loading} title="Refresh">
                <RefreshCw size={15} />
              </button>
            </div>
          </div>
          {error ? <div className="notification-error">{error}</div> : null}
          <div className="live-activity-list">
            {runningSchedules.map((schedule) => {
              const percent = pct(schedule);
              const sent = Number(schedule.sent_count || 0);
              const processed = Number(schedule.processed_count || 0);
              const total = Number(schedule.target_count || 0);
              const isActive = ['running', 'due', 'scheduled'].includes(String(schedule.status || ''));
              return (
                <div className="live-card live-current" key={schedule.id}>
                  <div className="live-card-title"><Send size={14} /> <strong>{schedule.type === 'follow_up' ? 'Follow-up sending now' : 'Email sending now'}</strong><span>{schedule.status}</span></div>
                  <div className="progress-track slim"><div className="progress-fill" style={{ width: `${percent}%` }} /></div>
                  <p>{processed || sent} processed · {sent} sent{total ? ` · ${total} total` : ''}</p>
                  {schedule.last_error ? <p className="live-now-text">{schedule.last_error}</p> : null}
                  {schedule.last_heartbeat_at ? <p>Last update {fmtTime(schedule.last_heartbeat_at)}</p> : null}
                  {isActive ? <button className="btn secondary mini" type="button" disabled={Boolean(stopId)} onClick={() => stopSchedule(schedule.id)}>{stopId === schedule.id ? 'Stopping…' : 'Stop'}</button> : null}
                </div>
              );
            })}

            {runningResearch.some((row) => row.status === 'running') ? (
              <div className="live-card live-current">
                <div className="live-card-title"><Search size={14} /> <strong>Auto Scout running now</strong><span>{runningResearch.length} active/queued</span></div>
                <p>Checking websites and looking for real contact emails.</p>
                {runningResearch.slice(0, 3).map((job) => <p key={job.id} className="muted">{job.status} · attempt {job.attempts || 0} · {fmtTime(job.updated_at || job.created_at)}</p>)}
              </div>
            ) : null}

            {liveEvents.map((event) => {
              const cls = eventClass(event.status);
              const Icon = event.kind === 'auto_scout' ? Search : cls === 'danger' ? XCircle : event.status === 'sent' ? Send : Loader2;
              return (
                <div className={`live-line live-event ${cls}`} key={eventKey(event)}>
                  <span className="live-event-icon">{cls === 'active' ? <Icon size={14} className="spin" /> : <Icon size={14} />}</span>
                  <div className="live-event-main">
                    <strong>{eventLabel(event)}</strong>
                    <p>{event.message || event.toEmail || event.businessName || 'Scout updated live work.'}</p>
                    {event.toEmail || event.fromEmail || event.businessName || event.website ? <small>{[shortEmail(event.fromEmail), event.toEmail ? `→ ${shortEmail(event.toEmail)}` : '', event.businessName, event.website].filter(Boolean).join(' · ')}</small> : null}
                  </div>
                  <em>{event.countText || fmtTime(event.createdAt)}</em>
                </div>
              );
            })}

            {!runningSchedules.length && !runningResearch.some((row) => row.status === 'running') && !liveEvents.length ? (
              <div className="notification-empty">Nothing is happening right now. Start Send Now, run Auto Scout, or wait for a due schedule.</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
