'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import { Business, BusinessStatus, Workspace } from '@/lib/types';
import { resolveBusinessLanguage } from '@/lib/template-language';
import { resolveBusinessCountry } from '@/lib/country-location';

const STATUS_OPTIONS: BusinessStatus[] = ['pending', 'scanning', 'found', 'ready', 'review', 'contacted', 'responded', 'no_inbox', 'bounced', 'invalid', 'duplicate', 'archived'];
const PAGE_SIZE = 100;
const BULK_PAGE_SIZE = 1000;

type StatusFilter = BusinessStatus | 'all';
type QueueStats = Record<string, number> & { total?: number; pending_no_email?: number };

function formatError(error: unknown) {
  if (!error) return 'Unknown error.';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    const item = error as { message?: string; code?: string; details?: string; hint?: string; error?: string };
    return [item.message || item.error, item.code ? `Code: ${item.code}` : '', item.details ? `Details: ${item.details}` : '', item.hint ? `Hint: ${item.hint}` : ''].filter(Boolean).join(' | ') || JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function csvEscape(value: unknown) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadBusinesses(name: string, businesses: Business[]) {
  if (!businesses.length) return;
  const headers = ['id', 'name', 'email', 'phone', 'website', 'domain', 'category', 'location', 'detected_country', 'detected_language', 'language_source', 'source', 'status', 'score', 'normalized_key', 'created_at', 'updated_at'];
  const lines = [headers.join(',')];
  for (const b of businesses) {
    const language = resolveBusinessLanguage(b);
    const row: Record<string, unknown> = { ...(b as unknown as Record<string, unknown>), detected_country: resolveBusinessCountry(b), detected_language: language.code, language_source: language.sourceLabel };
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function hasNoEmail(business: Business) {
  return !String(business.email || '').trim();
}

export default function BusinessQueueClient({ workspace }: { workspace: Workspace }) {
  const supabase = useMemo(() => createClient(), []);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [noEmailLimit, setNoEmailLimit] = useState(5000);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<QueueStats>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Loading cloud business queue...');
  const [error, setError] = useState('');
  const selectedIds = Object.keys(selected).filter((id) => selected[id]);

  async function loadStats() {
    const next: QueueStats = {};
    const { count: totalCount } = await supabase
      .from('businesses')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspace.id);
    next.total = totalCount || 0;

    const { count: pendingNoEmail } = await supabase
      .from('businesses')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspace.id)
      .in('status', ['pending', 'review', 'found'])
      .or('email.is.null,email.eq.');
    next.pending_no_email = pendingNoEmail || 0;

    await Promise.all(STATUS_OPTIONS.map(async (item) => {
      const { count } = await supabase
        .from('businesses')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspace.id)
        .eq('status', item);
      next[item] = count || 0;
    }));
    setStats(next);
  }

  async function loadBusinesses(nextPage = page) {
    setLoading(true);
    setError('');
    try {
      const from = nextPage * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      let query = supabase
        .from('businesses')
        .select('*', { count: 'exact' })
        .eq('workspace_id', workspace.id)
        .order('created_at', { ascending: false })
        .range(from, to);
      if (status !== 'all') query = query.eq('status', status);
      const cleanSearch = search.trim();
      if (cleanSearch) {
        const escaped = cleanSearch.replace(/[%_]/g, '');
        query = query.or(`name.ilike.%${escaped}%,email.ilike.%${escaped}%,domain.ilike.%${escaped}%,website.ilike.%${escaped}%,location.ilike.%${escaped}%`);
      }
      const { data, count, error: loadError } = await query;
      if (loadError) throw loadError;
      setBusinesses((data || []) as Business[]);
      setTotal(count || 0);
      setPage(nextPage);
      setMessage(`Showing ${(data || []).length.toLocaleString()} of ${(count || 0).toLocaleString()} matching business(es). Select no-email rows and send them to Auto Scout, or use the bulk Pending No-Email controls.`);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadBusinesses(0);
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function refresh() {
    await Promise.all([loadBusinesses(page), loadStats()]);
  }

  async function updateStatus(ids: string[], nextStatus: BusinessStatus) {
    if (!ids.length) return;
    setBusy(true);
    setError('');
    try {
      const { error: updateError } = await supabase
        .from('businesses')
        .update({ status: nextStatus })
        .eq('workspace_id', workspace.id)
        .in('id', ids);
      if (updateError) throw updateError;
      setSelected({});
      setMessage(`Updated ${ids.length.toLocaleString()} business(es) to ${nextStatus}.`);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    if (!selectedIds.length) return;
    const ok = confirm(`Delete ${selectedIds.length} selected business(es) from queue? This does not erase scout_history.`);
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      const { error: deleteError } = await supabase
        .from('businesses')
        .delete()
        .eq('workspace_id', workspace.id)
        .in('id', selectedIds);
      if (deleteError) throw deleteError;
      setSelected({});
      setMessage(`Deleted ${selectedIds.length.toLocaleString()} selected business(es).`);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function fetchPendingNoEmail(limit: number) {
    const max = Math.max(1, Math.min(50000, limit));
    const rows: Business[] = [];
    for (let from = 0; rows.length < max; from += BULK_PAGE_SIZE) {
      const to = from + Math.min(BULK_PAGE_SIZE, max - rows.length) - 1;
      const { data, error: fetchError } = await supabase
        .from('businesses')
        .select('*')
        .eq('workspace_id', workspace.id)
        .in('status', ['pending', 'review', 'found'])
        .or('email.is.null,email.eq.')
        .order('created_at', { ascending: true })
        .range(from, to);
      if (fetchError) throw fetchError;
      const chunk = (data || []) as Business[];
      rows.push(...chunk.filter(hasNoEmail));
      if (chunk.length < BULK_PAGE_SIZE) break;
    }
    return rows.slice(0, max);
  }

  async function queueForAutoScout(ids: string[], label = 'selected') {
    if (!ids.length) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/research/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: workspace.id, businessIds: ids, limit: ids.length })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json?.error || `Auto Scout queue failed with HTTP ${res.status}`);
      setSelected({});
      setMessage(`Sent ${Number(json.enqueued || 0).toLocaleString()} ${label} business(es) to Auto Scout. Open Auto Scout and click Start to begin finding emails.`);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function queuePendingNoEmail() {
    const limit = Math.max(1, Math.min(50000, noEmailLimit));
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/research/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: workspace.id, limit, noEmailOnly: true })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json?.error || `Auto Scout queue failed with HTTP ${res.status}`);
      setMessage(`Queued ${Number(json.enqueued || 0).toLocaleString()} pending/no-email business(es) for Auto Scout. Checked ${Number(json.checked || 0).toLocaleString()}.`);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function exportPendingNoEmail() {
    setBusy(true);
    setError('');
    try {
      const rows = await fetchPendingNoEmail(noEmailLimit);
      downloadBusinesses('scout-pending-no-email-for-auto-scout.csv', rows);
      setMessage(`Exported ${rows.length.toLocaleString()} pending/no-email business(es) for Auto Scout.`);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function deletePendingNoEmail() {
    const limit = Math.max(1, Math.min(50000, noEmailLimit));
    const ok = confirm(`Delete up to ${limit.toLocaleString()} pending/no-email business(es)? Use export first if you may need them later.`);
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      const rows = await fetchPendingNoEmail(limit);
      const ids = rows.map((row) => row.id);
      for (let i = 0; i < ids.length; i += 500) {
        const { error: deleteError } = await supabase.from('businesses').delete().eq('workspace_id', workspace.id).in('id', ids.slice(i, i + 500));
        if (deleteError) throw deleteError;
      }
      setMessage(`Deleted ${ids.length.toLocaleString()} pending/no-email business(es).`);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function archiveNoEmail() {
    const ok = confirm('Archive all pending/found/review businesses that have no email and no website/domain?');
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      const { error: rpcError } = await supabase.rpc('archive_empty_businesses', { target_workspace: workspace.id });
      if (rpcError) throw rpcError;
      setMessage('Archived empty/no-contact businesses. Businesses with website/domain remain available for Auto Scout.');
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleAll(value: boolean) {
    if (!value) return setSelected({});
    setSelected(Object.fromEntries(businesses.map((b) => [b.id, true])));
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const selectedNoEmailIds = businesses.filter((b) => selected[b.id] && hasNoEmail(b)).map((b) => b.id);

  return (
    <div className="stack">
      <div className="grid grid-4">
        <div className="card kpi"><div className="title">Total</div><div className="num">{(stats.total || 0).toLocaleString()}</div></div>
        <div className="card kpi"><div className="title">Pending</div><div className="num">{(stats.pending || 0).toLocaleString()}</div></div>
        <div className="card kpi"><div className="title">Pending No Email</div><div className="num">{(stats.pending_no_email || 0).toLocaleString()}</div></div>
        <div className="card kpi"><div className="title">Ready</div><div className="num">{(stats.ready || 0).toLocaleString()}</div></div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <div className="actions" style={{ justifyContent: 'space-between' }}>
          <div className="actions" style={{ flex: 1 }}>
            <input className="input" style={{ maxWidth: 360 }} placeholder="Search name, email, website, location..." value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') loadBusinesses(0); }} />
            <select className="select" style={{ maxWidth: 180 }} value={status} onChange={(event) => { setStatus(event.target.value as StatusFilter); setPage(0); }}>
              <option value="all">All statuses</option>
              {STATUS_OPTIONS.map((item) => <option key={item} value={item}>{item.replace('_', ' ')}</option>)}
            </select>
            <button className="btn secondary" type="button" onClick={() => loadBusinesses(0)} disabled={loading}>Search</button>
          </div>
          <button className="btn secondary" type="button" onClick={refresh} disabled={loading}>Refresh</button>
        </div>
        <div className={error ? 'error' : 'notice'} style={{ marginTop: 12 }}>{error || message}</div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Send No-Email Businesses to Auto Scout</h3>
        <p className="muted">Businesses without emails should stay Pending. From here you can send them to the Auto Scout queue, export them, or delete them after you are done.</p>
        <div className="actions" style={{ marginBottom: 12 }}>
          <input className="input" style={{ maxWidth: 160 }} type="number" min={1} max={50000} value={noEmailLimit} onChange={(event) => setNoEmailLimit(Math.max(1, Math.min(50000, Number(event.target.value) || 5000)))} />
          <button className="btn" type="button" disabled={busy} onClick={queuePendingNoEmail}>Queue Pending No-Email</button>
          <button className="btn secondary" type="button" disabled={!selectedNoEmailIds.length || busy} onClick={() => queueForAutoScout(selectedNoEmailIds, 'selected no-email')}>Queue Selected No-Email</button>
          <button className="btn secondary" type="button" disabled={busy} onClick={exportPendingNoEmail}>Export Pending No-Email</button>
          <button className="btn danger" type="button" disabled={busy} onClick={deletePendingNoEmail}>Delete Pending No-Email</button>
        </div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <div className="actions" style={{ marginBottom: 12 }}>
          <span className="badge">Selected: {selectedIds.length.toLocaleString()}</span>
          <button className="btn secondary" type="button" disabled={!selectedIds.length || busy} onClick={() => updateStatus(selectedIds, 'ready')}>Mark Ready</button>
          <button className="btn secondary" type="button" disabled={!selectedIds.length || busy} onClick={() => updateStatus(selectedIds, 'review')}>Mark Review</button>
          <button className="btn secondary" type="button" disabled={!selectedIds.length || busy} onClick={() => updateStatus(selectedIds, 'no_inbox')}>Move No Inbox</button>
          <button className="btn secondary" type="button" disabled={!selectedIds.length || busy} onClick={() => downloadBusinesses('scout-selected-businesses.csv', businesses.filter((b) => selected[b.id]))}>Export Selected</button>
          <button className="btn secondary" type="button" onClick={() => downloadBusinesses('scout-current-page.csv', businesses)}>Export Page</button>
          <button className="btn secondary" type="button" disabled={busy} onClick={archiveNoEmail}>Archive Empty</button>
          <button className="btn danger" type="button" disabled={!selectedIds.length || busy} onClick={deleteSelected}>Delete Selected</button>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th><input type="checkbox" checked={businesses.length > 0 && selectedIds.length === businesses.length} onChange={(event) => toggleAll(event.target.checked)} /></th>
                <th>Business</th><th>Email</th><th>Website</th><th>Country</th><th>Language</th><th>Status</th><th>Source</th><th>Added</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {businesses.map((b) => (
                <tr key={b.id}>
                  <td><input type="checkbox" checked={!!selected[b.id]} onChange={(event) => setSelected((current) => ({ ...current, [b.id]: event.target.checked }))} /></td>
                  <td><Link href={`/businesses/${b.id}`}><strong>{b.name || '-'}</strong></Link><br /><span className="muted">{b.category || ''} {b.location ? `· ${b.location}` : ''}</span><br /><Link className="muted" href={`/businesses/${b.id}`}>Open business →</Link></td>
                  <td>{b.email || <span className="muted">No email</span>}</td>
                  <td>{b.website || b.domain || <span className="muted">No site</span>}</td>
                  <td>{resolveBusinessCountry(b) || <span className="muted">Unassigned</span>}</td>
                  <td>{(() => { const language = resolveBusinessLanguage(b); return <><span className="badge">{language.label}</span><br /><span className="muted" style={{ fontSize: 11 }}>{language.sourceLabel}</span></>; })()}</td>
                  <td><span className={`status ${b.status}`}>{b.status.replace('_', ' ')}</span></td>
                  <td>{b.source || '-'}</td>
                  <td>{new Date(b.created_at).toLocaleString()}</td>
                  <td>
                    <div className="actions">
                      <select className="select" value={b.status} onChange={(event) => updateStatus([b.id], event.target.value as BusinessStatus)} disabled={busy}>
                        {STATUS_OPTIONS.map((item) => <option key={item} value={item}>{item.replace('_', ' ')}</option>)}
                      </select>
                      <Link className="btn secondary" href={`/businesses/${b.id}`}>Open</Link>
                      {b.email ? <Link className="btn secondary" href={`/message?business=${b.id}`}>Message</Link> : null}
                      {hasNoEmail(b) ? <button className="btn secondary" type="button" disabled={busy} onClick={() => queueForAutoScout([b.id], 'single no-email')}>Auto Scout</button> : null}
                    </div>
                  </td>
                </tr>
              ))}
              {!businesses.length ? (
                <tr><td colSpan={10} className="muted">No businesses found. Upload a CSV first or change filters.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="actions" style={{ justifyContent: 'space-between', marginTop: 14 }}>
          <button className="btn secondary" type="button" disabled={page <= 0 || loading} onClick={() => loadBusinesses(page - 1)}>Previous</button>
          <span className="muted">Page {page + 1} of {pages.toLocaleString()} · {total.toLocaleString()} total</span>
          <button className="btn secondary" type="button" disabled={page + 1 >= pages || loading} onClick={() => loadBusinesses(page + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
}
