'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import { emitLiveActivity } from '@/lib/live-activity-client';
import type { Workspace } from '@/lib/types';

type JobRow = {
  id: string;
  status: string;
  attempts: number;
  last_error?: string | null;
  result?: Record<string, unknown> | null;
  created_at: string;
  updated_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  businesses?: any;
};

type ScoutStats = Record<string, number> & {
  total_missing?: number;
  need_emails?: number;
  found_with_email?: number;
  stale_running?: number;
};

const SESSION_ENQUEUE_LIMIT = 50;
const RUN_BATCH_SIZE = 4;
const RUN_CONCURRENCY = 2;
const MAX_ROUNDS_PER_CLICK = 30;

function fmtError(error: unknown) {
  if (!error) return 'Unknown error';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function getBusiness(job: JobRow) {
  return Array.isArray(job.businesses) ? job.businesses[0] : job.businesses;
}

function getEmailFromResult(result: any) {
  return String(result?.email || result?.bestEmail || result?.best_email || result?.validatedEmail || result?.result?.email || result?.data?.email || (Array.isArray(result?.emails) ? result.emails[0] : '') || '').trim();
}

function getEvidenceFromResult(result: any) {
  if (!result || typeof result !== 'object') return '';
  const direct = result.sourceUrl || result.source_url || result.foundOn || result.found_on || result.contactPage || result.contact_page || result.page || result.url || result.sourceEvidence;
  if (direct) return String(direct);
  const deep = result.deepWebsiteFinder;
  if (deep?.sourceUrl) return String(deep.sourceUrl);
  const arrays = [result.sources, result.pages, result.urls, result.links, result.evidence, deep?.pages];
  for (const item of arrays) {
    if (Array.isArray(item) && item.length) {
      const first = item.find(Boolean);
      if (typeof first === 'string') return first;
      if (first && typeof first === 'object') return String(first.url || first.href || first.page || first.source || '');
    }
  }
  return '';
}

function getPagesChecked(result: any) {
  return Number(result?.deepWebsiteFinder?.pagesChecked || result?.pagesChecked || result?.websitePages?.pagesChecked || 0);
}

function getReason(job: JobRow) {
  const result: any = job.result || {};
  return String(job.last_error || result?.reason || result?.emailDecision?.reasons?.[0] || result?.backendError || '').trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export default function AutoScoutClient({ workspace }: { workspace: Workspace }) {
  const supabase = useMemo(() => createClient(), []);
  const stopRef = useRef(false);
  const cleanupDoneRef = useRef(false);
  const [stats, setStats] = useState<ScoutStats>({});
  const [recentJobs, setRecentJobs] = useState<JobRow[]>([]);
  const [message, setMessage] = useState('Ready. Click Find emails now. Scout will use the website URL already saved on each lead.');
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<any>(null);

  const queueCount = stats.queued || 0;
  const runningCount = stats.running || 0;
  const needsCount = stats.need_emails || 0;
  const staleCount = stats.stale_running || 0;

  const savedEmailRows = useMemo(() => {
    return recentJobs
      .map((job) => {
        const business = getBusiness(job);
        const email = String(business?.email || getEmailFromResult(job.result)).trim();
        const evidence = getEvidenceFromResult(job.result);
        return {
          id: String(business?.id || job.id || ''),
          businessName: String(business?.name || '').trim(),
          website: String(business?.website || business?.domain || '').trim(),
          email,
          evidence,
          pages: getPagesChecked(job.result),
          status: job.status
        };
      })
      .filter((row) => row.email)
      .slice(0, 25);
  }, [recentJobs]);

  const workingRows = useMemo(() => {
    return recentJobs
      .filter((job) => ['queued', 'running'].includes(String(job.status || '').toLowerCase()))
      .slice(0, 12);
  }, [recentJobs]);

  const checkedRows = useMemo(() => {
    return recentJobs
      .filter((job) => !['queued', 'running'].includes(String(job.status || '').toLowerCase()))
      .slice(0, 18);
  }, [recentJobs]);

  async function cleanupStuckJobs() {
    try {
      const res = await fetch('/api/research/cleanup-stuck', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: workspace.id })
      });
      const json = await res.json().catch(() => ({}));
      if (json?.reset) setMessage(`Cleaned ${Number(json.reset).toLocaleString()} stuck check(s). Click Find emails now to continue.`);
    } catch {
      // Cleanup is helpful, but the page must still load if it fails.
    }
  }

  async function loadStats() {
    try {
      const next: ScoutStats = {};
      await Promise.all(['queued', 'running', 'done', 'failed', 'cancelled'].map(async (status) => {
        const { count } = await supabase.from('email_research_jobs').select('id', { count: 'exact', head: true }).eq('workspace_id', workspace.id).eq('status', status);
        next[status] = count || 0;
      }));

      const { count: totalMissing } = await supabase
        .from('businesses')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspace.id)
        .or('email.is.null,email.eq.')
        .not('status', 'in', '(contacted,responded,bad_inbox,bounced,no_inbox,blocked,invalid,duplicate,archived,unsubscribed,do_not_contact,sent)');
      next.total_missing = totalMissing || 0;
      next.need_emails = Math.max((totalMissing || 0) - (next.queued || 0) - (next.running || 0), 0);

      const { count: foundWithEmail } = await supabase
        .from('businesses')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspace.id)
        .eq('status', 'found')
        .not('email', 'is', null)
        .neq('email', '');
      next.found_with_email = foundWithEmail || 0;

      const staleSince = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      const { count: staleRunning } = await supabase
        .from('email_research_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspace.id)
        .eq('status', 'running')
        .lt('updated_at', staleSince);
      next.stale_running = staleRunning || 0;
      setStats(next);

      const { data } = await supabase
        .from('email_research_jobs')
        .select('id,status,attempts,last_error,result,created_at,updated_at,started_at,finished_at,businesses(id,name,email,website,domain,category,location,status)')
        .eq('workspace_id', workspace.id)
        .order('updated_at', { ascending: false })
        .limit(45);
      setRecentJobs((data || []) as JobRow[]);
    } catch (error) {
      console.warn('Auto Scout refresh failed', error);
    }
  }

  useEffect(() => {
    if (!cleanupDoneRef.current) {
      cleanupDoneRef.current = true;
      cleanupStuckJobs().finally(loadStats);
    } else {
      loadStats();
    }
    const timer = window.setInterval(loadStats, running ? 2500 : 10000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, running]);

  async function runOneChunk() {
    const res = await fetch('/api/research/run-worker', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: workspace.id,
        autoEnqueue: true,
        enqueueLimit: SESSION_ENQUEUE_LIMIT,
        cycles: 1,
        batchSize: RUN_BATCH_SIZE,
        concurrency: RUN_CONCURRENCY
      })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) throw new Error(json.error || 'Email finding failed.');
    return json;
  }

  async function findEmailsNow() {
    if (running || busy) return;
    stopRef.current = false;
    setRunning(true);
    setBusy(true);
    setLastRun(null);
    let totalChecked = 0;
    let totalFound = 0;
    try {
      setMessage('Starting now. Scout will use saved website URLs only; no business-name guessing.');
      emitLiveActivity({ kind: 'auto_scout', status: 'starting', title: 'Auto Scout starting', message: 'Finding emails from saved business websites.' });

      for (let round = 1; round <= MAX_ROUNDS_PER_CLICK; round += 1) {
        if (stopRef.current) break;
        setMessage(`Checking websites now... group ${round}. Found ${totalFound.toLocaleString()} email(s) so far.`);
        const json = await runOneChunk();
        setLastRun(json);
        const checked = Number(json.processed || 0);
        const found = Number(json.found || 0);
        totalChecked += checked;
        totalFound += found;
        await loadStats();
        emitLiveActivity({ kind: 'auto_scout', status: 'checking', title: 'Auto Scout checking websites', message: `Checked ${totalChecked.toLocaleString()} lead(s), saved ${totalFound.toLocaleString()} email(s).` });
        if (!checked) break;
        await sleep(600);
      }

      await loadStats();
      if (stopRef.current) {
        setMessage(`Stopped after this group. Checked ${totalChecked.toLocaleString()} lead(s), saved ${totalFound.toLocaleString()} email(s). Click Find emails now to continue.`);
      } else if (!totalChecked) {
        setMessage('Nothing was checked. Either there are no missing-email leads with usable website URLs, or all current queued work is already finished.');
      } else {
        setMessage(`Finished this run. Checked ${totalChecked.toLocaleString()} lead(s), saved ${totalFound.toLocaleString()} trusted email(s). Click Find emails now again to continue the next group.`);
      }
      emitLiveActivity({ kind: 'auto_scout', status: 'complete', title: 'Auto Scout run finished', message: `Checked ${totalChecked.toLocaleString()} lead(s), saved ${totalFound.toLocaleString()} email(s).` });
    } catch (error) {
      setMessage(`Auto Scout stopped: ${fmtError(error)}. Leads were not marked complete just because the run stopped.`);
      emitLiveActivity({ kind: 'auto_scout', status: 'failed', title: 'Auto Scout stopped', message: fmtError(error) });
    } finally {
      setRunning(false);
      setBusy(false);
      await loadStats();
    }
  }

  function stopAfterCurrentGroup() {
    stopRef.current = true;
    setMessage('Stopping after the current small group finishes. Remaining leads stay available for the next run.');
  }

  async function refreshPage() {
    setBusy(true);
    await cleanupStuckJobs();
    await loadStats();
    setBusy(false);
  }

  return (
    <div className="space-y">
      <div className="notice">
        <b>New Auto Scout process:</b> Scout uses the website already saved on each lead. It checks the homepage/contact/about/support/impressum pages, saves the best trusted email, and skips rows that only have a business name, directory page, or IP address.
      </div>

      <div className="grid grid-4">
        <div className="card kpi"><div className="title">Missing Emails</div><div className="num">{needsCount.toLocaleString()}</div><p className="muted">Leads without usable email and not currently being checked.</p></div>
        <div className="card kpi"><div className="title">Next Queue</div><div className="num">{queueCount.toLocaleString()}</div><p className="muted">Already prepared. The main button continues from here.</p></div>
        <div className="card kpi"><div className="title">Checking Now</div><div className="num">{runningCount.toLocaleString()}</div><p className="muted">Live website checks. Stuck checks are cleaned automatically.</p></div>
        <div className="card kpi"><div className="title">Emails Saved</div><div className="num">{(stats.found_with_email || 0).toLocaleString()}</div><p className="muted">Trusted emails saved to leads.</p></div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <h3 style={{ marginTop: 0 }}>Find missing emails</h3>
        <p className="muted">One action. Scout takes the next missing leads with real website URLs, checks them in small safe groups, and saves trusted emails. No separate test buttons. No return-queue button.</p>
        <div className="actions" style={{ marginTop: 14 }}>
          <button className="btn" disabled={busy || running} onClick={findEmailsNow}>{queueCount > 0 ? 'Continue finding emails' : 'Find emails now'}</button>
          {running ? <button className="btn secondary" onClick={stopAfterCurrentGroup}>Stop after current group</button> : null}
          <button className="btn secondary mini" disabled={busy || running} onClick={refreshPage}>Refresh</button>
        </div>
        <div className={message.toLowerCase().includes('stopped') || message.toLowerCase().includes('failed') ? 'error' : 'notice'} style={{ marginTop: 14 }}>{message}</div>
        {staleCount > 0 ? <p className="muted" style={{ marginTop: 8 }}>Scout sees {staleCount.toLocaleString()} old stuck check(s). Refresh or Find emails now will clean them and continue.</p> : null}
        {lastRun ? <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>Last group: checked {Number(lastRun.processed || 0).toLocaleString()}, saved {Number(lastRun.found || 0).toLocaleString()}, queued/re-queued {Number(lastRun.enqueued || 0).toLocaleString()}.</p> : null}
      </div>

      <div className="grid grid-2">
        <div className="card" style={{ padding: 18 }}>
          <h3 style={{ marginTop: 0 }}>Working now / next</h3>
          <div className="table-wrap"><table><thead><tr><th>Business</th><th>Status</th><th>Website</th></tr></thead><tbody>
            {workingRows.map((job) => {
              const business = getBusiness(job);
              return <tr key={job.id}>
                <td>{business?.id ? <Link href={`/businesses/${business.id}`}><strong>{business?.name || '-'}</strong></Link> : <strong>{business?.name || '-'}</strong>}</td>
                <td><span className={`status ${job.status}`}>{job.status === 'queued' ? 'next' : 'checking'}</span></td>
                <td><span className="muted">{business?.website || business?.domain || '-'}</span></td>
              </tr>;
            })}
            {!workingRows.length ? <tr><td colSpan={3} className="muted">Nothing is currently queued on this page. Click Find emails now.</td></tr> : null}
          </tbody></table></div>
        </div>

        <div className="card" style={{ padding: 18 }}>
          <h3 style={{ marginTop: 0 }}>Emails saved</h3>
          <div className="table-wrap"><table><thead><tr><th>Email</th><th>Business</th><th>Proof</th></tr></thead><tbody>
            {savedEmailRows.map((row, index) => <tr key={`${row.id}-${row.email}-${index}`}>
              <td><strong>{row.email}</strong></td>
              <td>{row.id ? <Link href={`/businesses/${row.id}`}>{row.businessName || row.id}</Link> : row.businessName || '-'}</td>
              <td>{row.evidence ? <a href={row.evidence.startsWith('http') ? row.evidence : `https://${row.evidence}`} target="_blank" rel="noreferrer">source</a> : <span className="muted">{row.pages ? `${row.pages} page(s)` : '-'}</span>}</td>
            </tr>)}
            {!savedEmailRows.length ? <tr><td colSpan={3} className="muted">No trusted emails saved in recent checks yet.</td></tr> : null}
          </tbody></table></div>
        </div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3 style={{ marginTop: 0 }}>Recent checks</h3>
        <p className="simple-table-note">This is only for clarity. The important number is Emails Saved above.</p>
        <div className="table-wrap" style={{ marginTop: 12 }}><table><thead><tr><th>Business</th><th>Result</th><th>Email</th><th>Pages</th><th>Why</th></tr></thead><tbody>
          {checkedRows.map((job) => {
            const business = getBusiness(job);
            const email = String(business?.email || getEmailFromResult(job.result) || '').trim();
            const pages = getPagesChecked(job.result);
            const reason = getReason(job);
            const status = email ? 'saved' : job.status === 'failed' ? 'failed' : 'checked';
            return <tr key={job.id}>
              <td>{business?.id ? <Link href={`/businesses/${business.id}`}><strong>{business?.name || '-'}</strong></Link> : <strong>{business?.name || '-'}</strong>}<br /><span className="muted">{business?.website || business?.domain || ''}</span></td>
              <td><span className={`trust-pill ${email ? 'trusted' : job.status === 'failed' ? 'blocked' : 'none'}`}>{status}</span></td>
              <td>{email || <span className="muted">No email saved</span>}</td>
              <td>{pages ? `${pages}` : '-'}</td>
              <td><span className="muted">{reason || (email ? 'Trusted email saved.' : 'No trusted email found on checked pages.')}</span></td>
            </tr>;
          })}
          {!checkedRows.length ? <tr><td colSpan={5} className="muted">No recent checks yet.</td></tr> : null}
        </tbody></table></div>
      </div>
    </div>
  );
}
