'use client';

import { useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { Workspace } from '@/lib/types';
import { makeNormalizedKey, displayDomain, normalizeEmail, normalizePhone, normalizeWebsite } from '@/lib/normalize';

function download(filename: string, content: string, type = 'application/json') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function DataSafetyClient({ workspace }: { workspace: Workspace }) {
  const supabase = useMemo(() => createClient(), []);
  const [status, setStatus] = useState('Ready.');

  function exportLocalScoutedHistory() {
    const key = 'scout_team_scouted_local_v64';
    const raw = localStorage.getItem(key);
    if (!raw) {
      setStatus('No scout_team_scouted_local_v64 key found on this browser.');
      return;
    }
    download('scout-v7-local-scouted-history-backup.json', raw);
    setStatus('Downloaded local v7 scouted history backup.');
  }

  async function importLocalScoutedHistoryToCloud() {
    const key = 'scout_team_scouted_local_v64';
    const raw = localStorage.getItem(key);
    if (!raw) {
      setStatus('No scout_team_scouted_local_v64 key found on this browser.');
      return;
    }

    setStatus('Parsing local scouted history...');
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      setStatus(`Could not parse local history: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const byEmail = parsed?.byEmail && typeof parsed.byEmail === 'object' ? Object.values(parsed.byEmail) : [];
    const byDomain = parsed?.byDomain && typeof parsed.byDomain === 'object' ? Object.values(parsed.byDomain) : [];
    const entries = [...byEmail, ...byDomain].filter(Boolean) as any[];
    const map = new Map<string, any>();

    for (const item of entries) {
      const email = normalizeEmail(item.email || item.to || item.contactEmail);
      const website = normalizeWebsite(item.website || item.url || item.domain);
      const domain = displayDomain({ domain: item.domain, website, email });
      const name = String(item.name || item.businessName || item.company || '').trim();
      const phone = normalizePhone(item.phone || item.phoneNumber);
      const normalized_key = makeNormalizedKey({ email, domain, website, name, phone });
      if (!normalized_key) continue;
      map.set(normalized_key, { email, website, domain, name, phone, normalized_key, raw: item });
    }

    const rows = [...map.values()];
    if (!rows.length) {
      setStatus('Local history exists, but no importable email/domain/name records were found.');
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setStatus('Not signed in.');
      return;
    }

    let inserted = 0;
    for (let i = 0; i < rows.length; i += 300) {
      const part = rows.slice(i, i + 300);
      setStatus(`Importing local scouted history ${Math.min(i + part.length, rows.length)} / ${rows.length}...`);
      const payload = part.map((row) => ({
        workspace_id: workspace.id,
        normalized_key: row.normalized_key,
        email: row.email || null,
        domain: row.domain || null,
        website: row.website || null,
        name: row.name || null,
        phone: row.phone || null,
        source: 'v7_local_history',
        status: 'scouted',
        raw: row.raw,
        scouted_by: user.id
      }));
      const { data, error } = await supabase.from('scout_history').upsert(payload, {
        onConflict: 'workspace_id,normalized_key',
        ignoreDuplicates: true
      }).select('id');
      if (error) {
        setStatus(error.message);
        return;
      }
      inserted += data?.length || 0;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    setStatus(`Done. Added ${inserted} new scouted-history records to Supabase. Duplicates were skipped.`);
  }

  async function exportCloudData() {
    setStatus('Exporting cloud scout history and current businesses...');
    const [history, businesses] = await Promise.all([
      supabase.from('scout_history').select('*').eq('workspace_id', workspace.id).limit(50000),
      supabase.from('businesses').select('*').eq('workspace_id', workspace.id).limit(50000)
    ]);
    if (history.error || businesses.error) {
      setStatus(history.error?.message || businesses.error?.message || 'Export failed.');
      return;
    }
    download('scout-v8-cloud-backup.json', JSON.stringify({ exportedAt: new Date().toISOString(), history: history.data, businesses: businesses.data }, null, 2));
    setStatus('Downloaded cloud backup.');
  }

  return (
    <div className="stack">
      <div className="card" style={{ padding: 18 }}>
        <h3>Local v7 Backup</h3>
        <p className="muted">This reads only this browser. It helps rescue your old <code>scout_team_scouted_local_v64</code> history.</p>
        <div className="actions">
          <button className="btn secondary" onClick={exportLocalScoutedHistory}>Download local v7 scouted history</button>
          <button className="btn" onClick={importLocalScoutedHistoryToCloud}>Import local v7 history into cloud</button>
        </div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Cloud Backup</h3>
        <p className="muted">Download your Supabase current queue and team scouted history.</p>
        <button className="btn secondary" onClick={exportCloudData}>Download cloud backup</button>
      </div>

      <div className="notice">{status}</div>
    </div>
  );
}
