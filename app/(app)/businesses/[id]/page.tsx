import Link from 'next/link';
import { createClient } from '@/lib/supabase-server';
import { getCurrentWorkspace } from '@/lib/workspace';
import BusinessDetailActions from './BusinessDetailActions';
import BusinessConversationPanel from './BusinessConversationPanel';
import type { Business } from '@/lib/types';

function display(value: unknown) {
  const text = String(value ?? '').trim();
  return text || '—';
}

function sourceFromRaw(raw: any) {
  if (!raw || typeof raw !== 'object') return '';
  const candidate = raw.sourceUrl || raw.source_url || raw.foundOn || raw.found_on || raw.contactPage || raw.contact_page || raw.url || raw.website || raw.domain;
  return String(candidate || '').trim();
}

function prettyJson(value: unknown) {
  try { return JSON.stringify(value || {}, null, 2); } catch { return '{}'; }
}

function extractSocialLinks(raw: unknown) {
  const urls = new Set<string>();
  const text = (() => {
    try { return JSON.stringify(raw || {}); } catch { return String(raw || ''); }
  })();
  const matches = text.match(/https?:\\?\/\\?\/[^\s"'<>]+/gi) || [];
  const socialTerms = ['facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com/', 'tiktok.com', 'youtube.com', 'youtu.be', 'pinterest.com'];
  for (const match of matches) {
    const cleaned = match.replace(/\\\//g, '/').replace(/[),.;]+$/g, '');
    if (socialTerms.some((term) => cleaned.toLowerCase().includes(term))) urls.add(cleaned);
  }
  return Array.from(urls).slice(0, 12);
}

export default async function BusinessDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { workspace, error } = await getCurrentWorkspace();
  if (!workspace) return <div className="error">{error || 'No workspace found.'}</div>;

  const supabase = await createClient();
  const { data: business, error: businessError } = await supabase
    .from('businesses')
    .select('*')
    .eq('workspace_id', workspace.id)
    .eq('id', id)
    .maybeSingle();

  if (businessError) return <div className="error">{businessError.message}</div>;
  if (!business) return <div className="error">Business not found.</div>;

  const typedBusiness = business as Business;
  const [jobsRes, sentRes, repliesRes, candidatesRes, noInboxRes, accountsRes] = await Promise.all([
    supabase.from('email_research_jobs').select('*').eq('workspace_id', workspace.id).eq('business_id', id).order('created_at', { ascending: false }).limit(25),
    supabase.from('sent_messages').select('*').eq('workspace_id', workspace.id).eq('business_id', id).order('sent_at', { ascending: false }).limit(25),
    supabase.from('reply_history').select('*').eq('workspace_id', workspace.id).eq('business_id', id).order('received_at', { ascending: false }).limit(50),
    supabase.from('email_candidates').select('*').eq('workspace_id', workspace.id).eq('business_id', id).order('created_at', { ascending: false }).limit(25),
    supabase.from('no_inbox_records').select('*').eq('workspace_id', workspace.id).eq('business_id', id).order('created_at', { ascending: false }).limit(50),
    supabase.from('gmail_accounts').select('id,workspace_id,email,display_name,status,created_at,updated_at').eq('workspace_id', workspace.id).order('created_at', { ascending: false })
  ]);

  const sourceEvidence = sourceFromRaw((typedBusiness.raw as any)?.backend_email_research || typedBusiness.raw);
  const hasEmail = Boolean(String(typedBusiness.email || '').trim());
  const socialLinks = extractSocialLinks(typedBusiness.raw);

  return (
    <div className="stack">
      <div className="topbar">
        <div className="page-title">
          <h2>{typedBusiness.name || 'Business'}</h2>
          <p>Business record, conversation history, Auto Scout history, and messaging actions.</p>
        </div>
        <Link className="btn secondary" href="/businesses">Back to Businesses</Link>
      </div>

      <div className="grid grid-3">
        <div className="card kpi"><div className="title">Status</div><div className="num status">{typedBusiness.status.replace('_', ' ')}</div></div>
        <div className="card kpi"><div className="title">Email</div><div className="num" style={{ fontSize: 18 }}>{display(typedBusiness.email)}</div></div>
        <div className="card kpi"><div className="title">Website / Domain</div><div className="num" style={{ fontSize: 18 }}>{display(typedBusiness.website || typedBusiness.domain)}</div></div>
      </div>

      <BusinessDetailActions workspace={workspace} businessId={id} hasEmail={hasEmail} currentStatus={typedBusiness.status} />

      <BusinessConversationPanel workspace={workspace} business={typedBusiness as any} accounts={(accountsRes.data || []) as any} sentRows={(sentRes.data || []) as any} replyRows={(repliesRes.data || []) as any} noInboxRows={(noInboxRes.data || []) as any} socialLinks={socialLinks} />

      <div className="grid grid-2">
        <div className="card" style={{ padding: 18 }}>
          <h3>Contact & Source</h3>
          <table><tbody>
            <tr><th>Name</th><td>{display(typedBusiness.name)}</td></tr>
            <tr><th>Email</th><td>{display(typedBusiness.email)}</td></tr>
            <tr><th>Phone</th><td>{display(typedBusiness.phone)}</td></tr>
            <tr><th>Website</th><td>{display(typedBusiness.website)}</td></tr>
            <tr><th>Domain</th><td>{display(typedBusiness.domain)}</td></tr>
            <tr><th>Category</th><td>{display(typedBusiness.category)}</td></tr>
            <tr><th>Location</th><td>{display(typedBusiness.location)}</td></tr>
            <tr><th>Source</th><td>{display(typedBusiness.source)}</td></tr>
            <tr><th>Evidence</th><td>{sourceEvidence ? <a href={sourceEvidence.startsWith('http') ? sourceEvidence : `https://${sourceEvidence}`} target="_blank" rel="noreferrer">{sourceEvidence}</a> : <span className="muted">No source evidence supplied by backend yet.</span>}</td></tr>
          </tbody></table>
        </div>

        <div className="card" style={{ padding: 18 }}>
          <h3>Email Candidates</h3>
          <div className="table-wrap"><table><thead><tr><th>Email</th><th>Status</th><th>Score</th><th>Source</th></tr></thead><tbody>
            {(candidatesRes.data || []).map((row: any) => <tr key={row.id}><td>{row.email}</td><td>{row.status}</td><td>{row.score || '—'}</td><td>{row.source || '—'}</td></tr>)}
            {!(candidatesRes.data || []).length ? <tr><td colSpan={4} className="muted">No email candidates recorded yet.</td></tr> : null}
          </tbody></table></div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card" style={{ padding: 18 }}>
          <h3>Auto Scout Jobs</h3>
          <div className="table-wrap"><table><thead><tr><th>Status</th><th>Attempts</th><th>Result</th><th>Error</th></tr></thead><tbody>
            {(jobsRes.data || []).map((row: any) => <tr key={row.id}><td>{row.status}</td><td>{row.attempts}</td><td>{display(row.result?.email || row.result?.bestEmail || row.result?.best_email)}</td><td>{display(row.last_error)}</td></tr>)}
            {!(jobsRes.data || []).length ? <tr><td colSpan={4} className="muted">No Auto Scout jobs yet.</td></tr> : null}
          </tbody></table></div>
        </div>

        <div className="card" style={{ padding: 18 }}>
          <h3>Reply Classification Summary</h3>
          <p className="muted">Compact record of sent messages and classified inbound messages. Use the full conversation panel above to respond.</p>
          <div className="table-wrap"><table><thead><tr><th>Type</th><th>Email</th><th>Subject</th><th>Date</th></tr></thead><tbody>
            {(sentRes.data || []).map((row: any) => <tr key={`s-${row.id}`}><td>Sent</td><td>{row.to_email}</td><td>{row.subject}</td><td>{new Date(row.sent_at).toLocaleString()}</td></tr>)}
            {(repliesRes.data || []).map((row: any) => <tr key={`r-${row.id}`}><td>{row.is_real_reply ? 'Reply' : row.is_auto_reply ? 'Auto reply' : row.classification || 'Other inbound'}</td><td>{row.from_email}</td><td>{row.subject}</td><td>{new Date(row.received_at).toLocaleString()}</td></tr>)}
            {!(sentRes.data || []).length && !(repliesRes.data || []).length ? <tr><td colSpan={4} className="muted">No messages or replies recorded yet.</td></tr> : null}
          </tbody></table></div>
        </div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Raw Imported / Research Data</h3>
        <textarea className="textarea" readOnly value={prettyJson(typedBusiness.raw)} style={{ minHeight: 240, fontFamily: 'monospace' }} />
      </div>
    </div>
  );
}
