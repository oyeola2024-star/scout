'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Copy, ExternalLink, Search, UploadCloud, Wand2, Radar, Globe2 } from 'lucide-react';
import type { MessageCategory, Workspace } from '@/lib/types';
import { createClient } from '@/lib/supabase-browser';
import { buildSourceScoutDorks, searchUrl, type SourceScoutMode } from '@/lib/source-scout';

type ImportResponse = {
  success?: boolean;
  error?: string;
  parsed?: number;
  inserted?: number;
  skippedOrDuplicate?: number;
  directEmails?: number;
  websiteOnly?: number;
  queuedAutoScout?: number;
  fetchedPages?: number;
  fetchedSample?: Array<{ url?: string; finalUrl?: string; ok?: boolean; status?: number; title?: string; emails?: string[]; websites?: string[]; error?: string }>;
  fetchErrors?: string[];
  sample?: Array<Record<string, unknown>>;
  rejected?: Array<{ value: string; reason: string }>;
};

function fmt(value: unknown) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num.toLocaleString() : '0';
}

function sampleValue(row: Record<string, unknown>, key: string) {
  return String(row[key] || '').slice(0, 140);
}

export default function SourceScoutClient({ workspace }: { workspace: Workspace }) {
  const supabase = useMemo(() => createClient(), []);
  const [sourceMode, setSourceMode] = useState<SourceScoutMode>('bing_dork');
  const [categories, setCategories] = useState<MessageCategory[]>([]);
  const [audienceCategoryId, setAudienceCategoryId] = useState(workspace.default_audience_category_id || '');
  const [newAudienceCategory, setNewAudienceCategory] = useState(workspace.default_audience_category_name || '');
  const [niche, setNiche] = useState('Shopify stores');
  const [location, setLocation] = useState('Germany');
  const [country, setCountry] = useState('');
  const [scoutSignals, setScoutSignals] = useState('contact email\nbook a call\nget a quote\nwebsite owner');
  const [text, setText] = useState('');
  const [startUrls, setStartUrls] = useState('');
  const [maxPages, setMaxPages] = useState(20);
  const [maxSearchQueries, setMaxSearchQueries] = useState(3);
  const [directEmailsReady, setDirectEmailsReady] = useState(true);
  const [enqueueWebsiteAutoScout, setEnqueueWebsiteAutoScout] = useState(true);
  const [busy, setBusy] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [message, setMessage] = useState('Ready. Use Auto Source Scout to fetch search/directory pages, extract visible emails/websites, and queue websites for Auto Scout.');

  const dorks = useMemo(() => buildSourceScoutDorks({ niche, location, country, sourceMode, signals: scoutSignals }), [niche, location, country, sourceMode, scoutSignals]);
  const extensionEndpoint = typeof window === 'undefined' ? '' : `${window.location.origin}/api/extension/ingest`;
  const selectedAudienceCategory = categories.find((c) => c.id === audienceCategoryId) || null;
  const audienceCategoryName = selectedAudienceCategory?.name || newAudienceCategory.trim() || '';

  async function loadCategories() {
    const { data, error } = await supabase
      .from('message_categories')
      .select('*')
      .eq('workspace_id', workspace.id)
      .eq('active', true)
      .order('name', { ascending: true });
    if (error) throw error;
    setCategories((data || []) as MessageCategory[]);
  }

  useEffect(() => {
    loadCategories().catch((err) => setMessage(`Could not load categories: ${err instanceof Error ? err.message : String(err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  async function ensureAudienceCategory() {
    if (audienceCategoryId) return { id: audienceCategoryId, name: selectedAudienceCategory?.name || newAudienceCategory.trim() || '' };
    const name = newAudienceCategory.trim();
    if (!name) return { id: '', name: '' };
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from('message_categories')
      .upsert({ workspace_id: workspace.id, name, description: 'Audience category created from Source Scout.', active: true, created_by: user?.id || null }, { onConflict: 'workspace_id,name' })
      .select('*')
      .single();
    if (error) throw error;
    setAudienceCategoryId(data.id);
    setNewAudienceCategory(data.name || name);
    await loadCategories();
    return { id: data.id as string, name: String(data.name || name) };
  }

  async function copy(value: string, label: string) {
    await navigator.clipboard.writeText(value);
    setMessage(`${label} copied.`);
  }

  async function submit(previewOnly = false) {
    setBusy(true);
    setResult(null);
    setMessage(previewOnly ? 'Analyzing pasted source...' : 'Importing source leads and queuing website-only leads for Auto Scout...');
    try {
      const category = await ensureAudienceCategory();
      const res = await fetch('/api/source-scout/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: workspace.id, sourceMode, niche, location, country, scoutSignals, text, directEmailsReady, enqueueWebsiteAutoScout, previewOnly, audienceCategoryId: category.id, audienceCategoryName: category.name })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || 'Source Scout request failed.');
      setResult(json);
      setMessage(previewOnly
        ? `Preview found ${fmt(json.leads?.length || json.parsed)} lead(s).`
        : `Imported ${fmt(json.inserted)} lead(s). Direct emails: ${fmt(json.directEmails)}. Website-only queued for Auto Scout: ${fmt(json.queuedAutoScout)}.`);
    } catch (error) {
      setMessage(`Source Scout failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runAutoSourceScout() {
    setAutoBusy(true);
    setResult(null);
    setMessage('Auto Source Scout is fetching search/directory pages. It will extract visible emails, discover websites, and queue website-only leads for Auto Scout.');
    try {
      const category = await ensureAudienceCategory();
      const res = await fetch('/api/source-scout/auto-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId: workspace.id,
          sourceMode,
          niche,
          location,
          country,
          audienceCategoryId: category.id,
          audienceCategoryName: category.name,
          startUrls,
          maxPages,
          maxSearchQueries,
          directEmailsReady,
          enqueueWebsiteAutoScout,
          scoutSignals
        })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || 'Auto Source Scout failed.');
      setResult(json);
      setMessage(`Auto Source Scout finished. Fetched ${fmt(json.fetchedPages)} page(s), imported ${fmt(json.inserted)} lead(s), direct emails ${fmt(json.directEmails)}, queued ${fmt(json.queuedAutoScout)} website(s) for Auto Scout.`);
    } catch (error) {
      setMessage(`Auto Source Scout failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAutoBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="notice">
        <b>Correct flow:</b> Source Scout should not only copy text. It can now auto-fetch Bing/search result pages or directory URLs, extract emails/websites it sees, import direct emails as Ready, and queue website-only leads for Auto Scout. Auto Scout is the deep website checker.
      </div>

      <div className="grid grid-3">
        <div className="card kpi"><div className="title">Direct email extraction</div><div className="num">Email</div><p className="muted">Emails visible on fetched search results, directory pages, or imported extension pages can go Ready.</p></div>
        <div className="card kpi"><div className="title">Website discovery</div><div className="num">Site</div><p className="muted">If no email is visible, Scout imports the official website/business lead.</p></div>
        <div className="card kpi"><div className="title">Auto Scout handoff</div><div className="num">Deep</div><p className="muted">Website-only leads are queued so Auto Scout checks real contact, about, and legal/impressum pages through this Scout deployment.</p></div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <div className="grid grid-3">
          <div>
            <label className="label">Source type</label>
            <select className="select" value={sourceMode} onChange={(e) => setSourceMode(e.target.value as SourceScoutMode)}>
              <option value="bing_dork">Bing dorking</option>
              <option value="google_dork">Google dorking links</option>
              <option value="directory">Directory website</option>
              <option value="extension">Extension import</option>
              <option value="mixed">Mixed source</option>
            </select>
          </div>
          <div>
            <label className="label">Audience category</label>
            <select className="select" value={audienceCategoryId} onChange={(e) => { setAudienceCategoryId(e.target.value); const cat = categories.find((c) => c.id === e.target.value); if (cat) setNewAudienceCategory(cat.name); }}>
              <option value="">New / uncategorized</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">New category name</label>
            <input className="input" value={newAudienceCategory} onChange={(e) => { setNewAudienceCategory(e.target.value); if (audienceCategoryId) setAudienceCategoryId(''); }} placeholder="Airtable service, Marketing, Shopify audit" />
          </div>
          <div>
            <label className="label">Niche / business type</label>
            <input className="input" value={niche} onChange={(e) => setNiche(e.target.value)} placeholder="dentists, Shopify stores, restaurants" />
          </div>
          <div>
            <label className="label">City / area</label>
            <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="London, Texas, Berlin" />
          </div>
          <div>
            <label className="label">Country / extra filter</label>
            <input className="input" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="optional" />
          </div>
        </div>
        <label className="label" style={{ marginTop: 12 }}>Scout signals used for dorking</label>
        <textarea className="textarea" value={scoutSignals} onChange={(e) => setScoutSignals(e.target.value)} placeholder={"contact email\nbook a call\nget a quote\nshopify store owner"} style={{ minHeight: 90 }} />
      </div>

      <div className="card" style={{ padding: 18 }}>
        <div className="topbar" style={{ marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>Auto Source Scout</h3>
            <p className="muted" style={{ margin: '5px 0 0' }}>This is the no-copy workflow. Add directory/search URLs or let Scout run a few Bing dorks, then it fetches pages itself.</p>
          </div>
          <button className="btn" disabled={autoBusy} onClick={runAutoSourceScout}><Radar size={16} /> {autoBusy ? 'Running...' : 'Run Auto Source Scout'}</button>
        </div>
        <div className="grid grid-2">
          <div>
            <label className="label">Optional directory/search/result URLs to fetch automatically</label>
            <textarea className="textarea" value={startUrls} onChange={(e) => setStartUrls(e.target.value)} placeholder={'Paste URLs only if you already have them. Example:\nhttps://www.bing.com/search?q=dentists+texas+contact+email\nhttps://example-directory.com/restaurants/london'} />
          </div>
          <div className="stack">
            <div className="grid grid-2">
              <div>
                <label className="label">Bing dork queries to auto fetch</label>
                <input className="input" type="number" min={0} max={8} value={maxSearchQueries} onChange={(e) => setMaxSearchQueries(Number(e.target.value || 0))} />
              </div>
              <div>
                <label className="label">Max pages to visit</label>
                <input className="input" type="number" min={1} max={60} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value || 1))} />
              </div>
            </div>
            <label className="checkbox-row"><input type="checkbox" checked={directEmailsReady} onChange={(e) => setDirectEmailsReady(e.target.checked)} /> Direct emails found automatically should go to Ready.</label>
            <label className="checkbox-row"><input type="checkbox" checked={enqueueWebsiteAutoScout} onChange={(e) => setEnqueueWebsiteAutoScout(e.target.checked)} /> Website-only leads should be queued for Auto Scout.</label>
            <div className="notice"><b>Note:</b> Google may block automated fetching. Direct business websites, Bing results, and directory URLs work better. Auto Scout checks public pages only and keeps uncertain results for review.</div>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <div className="topbar" style={{ marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>Dork queries</h3>
            <p className="muted" style={{ margin: '5px 0 0' }}>You can still open or copy them manually, but Auto Source Scout can run the first few Bing dorks above.</p>
          </div>
          <button className="btn secondary" onClick={() => copy(dorks.join('\n'), 'Dorks')}><Copy size={16} /> Copy all</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Dork query</th><th>Open</th><th>Copy</th></tr></thead>
            <tbody>
              {dorks.map((dork) => (
                <tr key={dork}>
                  <td><code>{dork}</code></td>
                  <td className="actions">
                    <a className="btn secondary" href={searchUrl('google', dork)} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Google</a>
                    <a className="btn secondary" href={searchUrl('bing', dork)} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Bing</a>
                  </td>
                  <td><button className="btn secondary" onClick={() => copy(dork, 'Dork')}><Copy size={15} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <div className="grid grid-2">
          <div>
            <label className="label">Manual fallback: paste result text, directory HTML, website list, or email list</label>
            <textarea className="textarea" style={{ minHeight: 240 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Example:\nABC Dental | https://abcdental.com | info@abcdental.com\nExample Shop Germany - www.exampleshop.de\ninfo@example.com'} />
          </div>
          <div className="stack">
            <div className="notice"><b>Manual fallback:</b> use this only when a directory/search page blocks automatic fetching or you want to paste extension text.</div>
            <div className="actions">
              <button className="btn secondary" disabled={busy || !text.trim()} onClick={() => submit(true)}><Search size={16} /> Preview pasted text</button>
              <button className="btn" disabled={busy || !text.trim()} onClick={() => submit(false)}><UploadCloud size={16} /> Import pasted text</button>
              <Link className="btn secondary" href="/auto-scout"><Wand2 size={16} /> Go to Auto Scout</Link>
            </div>
            <div className={message.toLowerCase().includes('failed') ? 'error' : 'success'}>{message}</div>
          </div>
        </div>
      </div>

      {result && (
        <div className="grid grid-4">
          <div className="card kpi"><div className="title">Fetched pages</div><div className="num">{fmt(result.fetchedPages)}</div></div>
          <div className="card kpi"><div className="title">Inserted</div><div className="num">{fmt(result.inserted)}</div></div>
          <div className="card kpi"><div className="title">Direct emails</div><div className="num">{fmt(result.directEmails)}</div></div>
          <div className="card kpi"><div className="title">Queued Auto Scout</div><div className="num">{fmt(result.queuedAutoScout)}</div></div>
        </div>
      )}

      {result?.fetchedSample?.length ? (
        <div className="card" style={{ padding: 18 }}>
          <h3 style={{ marginTop: 0 }}>Fetched pages</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Page</th><th>Status</th><th>Emails seen</th><th>Websites found</th></tr></thead>
              <tbody>
                {result.fetchedSample.slice(0, 30).map((page, idx) => (
                  <tr key={`${page.finalUrl || page.url}-${idx}`}>
                    <td><a className="detail-link" href={page.finalUrl || page.url} target="_blank" rel="noreferrer">{page.title || page.finalUrl || page.url}</a></td>
                    <td>{page.ok ? `OK ${page.status}` : page.error || `HTTP ${page.status || 0}`}</td>
                    <td>{page.emails?.slice(0, 4).join(', ') || <span className="muted">None on this page</span>}</td>
                    <td>{fmt(page.websites?.length || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {result?.sample?.length ? (
        <div className="card" style={{ padding: 18 }}>
          <h3 style={{ marginTop: 0 }}>Sample leads</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Website</th><th>Status logic</th></tr></thead>
              <tbody>
                {result.sample.slice(0, 50).map((row, idx) => (
                  <tr key={idx}>
                    <td>{sampleValue(row, 'name')}</td>
                    <td>{sampleValue(row, 'email') || <span className="muted">No direct email</span>}</td>
                    <td>{sampleValue(row, 'website') || <span className="muted">No website</span>}</td>
                    <td>{sampleValue(row, 'reason')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="card" style={{ padding: 18 }}>
        <h3 style={{ marginTop: 0 }}>Extension bridge</h3>
        <p className="muted">The extension posts captured businesses into Scout through this endpoint. Captured websites are then queued for Auto Scout.</p>
        <div className="grid grid-2">
          <div>
            <label className="label">Extension ingest endpoint</label>
            <div className="actions"><input className="input" value={extensionEndpoint} readOnly /><button className="btn secondary" onClick={() => copy(extensionEndpoint, 'Endpoint')}>Copy</button></div>
          </div>
          <div>
            <label className="label">Workspace key</label>
            <div className="actions"><input className="input" value={workspace.api_key || 'Open Data Safety or Settings to reveal/copy the workspace key'} readOnly /><button className="btn secondary" disabled={!workspace.api_key} onClick={() => copy(workspace.api_key || '', 'Workspace key')}>Copy</button></div>
          </div>
        </div>
      </div>
    </div>
  );
}
