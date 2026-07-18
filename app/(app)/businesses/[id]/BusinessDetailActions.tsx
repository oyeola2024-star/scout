'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import type { BusinessStatus, Workspace } from '@/lib/types';

function fmtError(error: unknown) {
  if (!error) return 'Unknown error';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

export default function BusinessDetailActions({ workspace, businessId, hasEmail, currentStatus }: { workspace: Workspace; businessId: string; hasEmail: boolean; currentStatus: BusinessStatus }) {
  const supabase = createClient();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function setStatus(status: BusinessStatus) {
    setBusy(true);
    setMessage('');
    try {
      const { error } = await supabase.from('businesses').update({ status }).eq('workspace_id', workspace.id).eq('id', businessId);
      if (error) throw error;
      setMessage(`Business moved to ${status.replace('_', ' ')}. Refresh the page to see latest status.`);
    } catch (error) {
      setMessage(`Status update failed: ${fmtError(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function queueForAutoScout() {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/research/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: workspace.id, businessIds: [businessId], limit: 1 })
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.success) throw new Error(json.error || `Queue failed with HTTP ${response.status}`);
      setMessage('Queued this business for Auto Scout. Open Auto Scout and start processing when ready.');
    } catch (error) {
      setMessage(`Auto Scout queue failed: ${fmtError(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: 18 }}>
      <h3>Business Actions</h3>
      <p className="muted">Use this page as the single business record: decide whether it needs Auto Scout, can be messaged, should be reviewed, or should be removed from the active queue.</p>
      <div className="actions">
        {hasEmail ? <Link className="btn" href={`/message?business=${businessId}`}>Message this business</Link> : <button className="btn" type="button" disabled={busy} onClick={queueForAutoScout}>Send to Auto Scout</button>}
        <button className="btn secondary" type="button" disabled={busy} onClick={() => setStatus('ready')}>Mark Ready</button>
        <button className="btn secondary" type="button" disabled={busy} onClick={() => setStatus('review')}>Mark Review</button>
        <button className="btn secondary" type="button" disabled={busy} onClick={() => setStatus('no_inbox')}>Move No Inbox</button>
        <button className="btn danger" type="button" disabled={busy} onClick={() => setStatus('archived')}>Archive</button>
      </div>
      <div className="notice" style={{ marginTop: 12 }}>
        Current status: <strong>{currentStatus.replace('_', ' ')}</strong>. {hasEmail ? 'This record has an email and can be prepared for sending.' : 'This record has no email; Auto Scout should research it first.'}
      </div>
      {message ? <div className={message.includes('failed') ? 'error' : 'success'} style={{ marginTop: 12 }}>{message}</div> : null}
    </div>
  );
}
