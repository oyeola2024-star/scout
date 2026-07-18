'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Bell, CheckCheck, MessageSquareReply, Ban, AlertTriangle, RefreshCw } from 'lucide-react';
import { createClient } from '@/lib/supabase-browser';
import type { Workspace } from '@/lib/types';

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  message?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  business_id?: string | null;
  read_at?: string | null;
  raw?: Record<string, any> | null;
  created_at: string;
};

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function formatTime(value: string) {
  try { return new Date(value).toLocaleString(); } catch { return value; }
}

function iconFor(type: string) {
  const lower = type.toLowerCase();
  if (lower.includes('real_reply')) return <MessageSquareReply size={18} />;
  if (lower.includes('blocked') || lower.includes('no_inbox') || lower.includes('bounce')) return <Ban size={18} />;
  if (lower.includes('limit') || lower.includes('failed')) return <AlertTriangle size={18} />;
  return <Bell size={18} />;
}

function toneFor(type: string) {
  const lower = type.toLowerCase();
  if (lower.includes('real_reply')) return 'good';
  if (lower.includes('blocked') || lower.includes('no_inbox') || lower.includes('bounce') || lower.includes('failed')) return 'bad';
  if (lower.includes('auto_reply') || lower.includes('limit')) return 'warn';
  return '';
}

export default function NotificationsClient({ workspace }: { workspace: Workspace }) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [items, unreadCount] = await Promise.all([
        supabase.from('app_notifications').select('*').eq('workspace_id', workspace.id).order('created_at', { ascending: false }).limit(200),
        supabase.from('app_notifications').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).is('read_at', null)
      ]);
      if (items.error) throw items.error;
      if (unreadCount.error) throw unreadCount.error;
      setRows((items.data || []) as NotificationRow[]);
      setUnread(unreadCount.count || 0);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const onRefresh = () => load();
    const onFocus = () => load();
    window.addEventListener('scout-notifications-refresh', onRefresh);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    const timer = window.setInterval(load, 15000);
    return () => {
      window.removeEventListener('scout-notifications-refresh', onRefresh);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  async function markRead(id?: string) {
    setError('');
    try {
      const response = await fetch('/api/notifications/mark-read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: workspace.id, id: id || null, all: !id })
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json?.success === false) throw new Error(json?.error || `Mark-read failed with HTTP ${response.status}`);
      await load();
    } catch (err) {
      setError(formatError(err));
    }
  }

  return (
    <div className="stack">
      <div className="hero">
        <div>
          <div className="eyebrow">Scout v8.33</div>
          <h1>Notifications</h1>
          <p>Persistent list of replies, auto-like messages, bounces, blocked-message notices, Gmail limits, and important app run signals. This is not just a popup; it stays here until you read it.</p>
        </div>
        <div className="actions">
          <button className="btn secondary" type="button" onClick={load} disabled={loading}><RefreshCw size={16} /> Refresh</button>
          <button className="btn" type="button" onClick={() => markRead()} disabled={!unread}><CheckCheck size={16} /> Mark all read</button>
        </div>
      </div>

      {error ? <div className="alert bad">{error}</div> : null}
      <div className="grid grid-4">
        <div className="card kpi"><div className="title">Unread</div><div className="num">{unread.toLocaleString()}</div><p>Needs attention</p></div>
        <div className="card kpi"><div className="title">Recent</div><div className="num">{rows.length.toLocaleString()}</div><p>Last 200 notifications</p></div>
        <div className="card kpi"><div className="title">Replies</div><div className="num">{rows.filter((r) => r.type === 'real_reply').length.toLocaleString()}</div><p>In this list</p></div>
        <div className="card kpi"><div className="title">Delivery Issues</div><div className="num">{rows.filter((r) => /(no_inbox|blocked|bounce)/i.test(r.type)).length.toLocaleString()}</div><p>Clean before more sends</p></div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Notification Feed</h3>
        <div className="stack" style={{ gap: 10 }}>
          {rows.map((row) => (
            <div key={row.id} className={`card ${toneFor(row.type)}`} style={{ padding: 14, borderLeft: row.read_at ? undefined : '4px solid var(--accent)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <div>{iconFor(row.type)}</div>
                  <div>
                    <strong>{row.title}</strong>
                    <div className="muted" style={{ marginTop: 4 }}>{formatTime(row.created_at)} · {row.type.replace(/_/g, ' ')}</div>
                    {row.message ? <p style={{ marginTop: 8 }}>{row.message}</p> : null}
                    {row.business_id ? <Link href={`/businesses/${row.business_id}`}>Open business</Link> : row.type === 'real_reply' ? <Link href="/replies">Open replies</Link> : null}
                  </div>
                </div>
                {!row.read_at ? <button className="btn secondary" type="button" onClick={() => markRead(row.id)}>Mark read</button> : <span className="muted">Read</span>}
              </div>
            </div>
          ))}
          {!rows.length ? <div className="notice">No notifications yet. Run Inbox Sync or Full Autopilot after messages have been sent.</div> : null}
        </div>
      </div>
    </div>
  );
}
