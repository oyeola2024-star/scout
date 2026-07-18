import Link from 'next/link';
import { createClient } from '@/lib/supabase-server';
import { getCurrentWorkspace } from '@/lib/workspace';

function text(value: unknown) {
  return String(value || '').trim() || '-';
}

export default async function NoInboxPage() {
  const { workspace, error } = await getCurrentWorkspace();
  if (!workspace) return <div className="error">Workspace error: {error}</div>;
  const supabase = await createClient();
  const { data: records, error: recordsError } = await supabase
    .from('no_inbox_records')
    .select('*, businesses(name,website,domain,status)')
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false })
    .limit(500);

  const { data: businesses, error: businessError } = await supabase
    .from('businesses')
    .select('id,name,email,website,domain,status,updated_at')
    .eq('workspace_id', workspace.id)
    .in('status', ['no_inbox', 'bounced', 'invalid'])
    .order('updated_at', { ascending: false })
    .limit(200);

  const rows = (records || []) as any[];
  const fallbackBusinesses = (businesses || []) as any[];
  const noInboxCount = rows.filter((r) => String(r.reason || '').includes('no_inbox')).length;
  const blockedCount = rows.filter((r) => String(r.reason || '').includes('blocked')).length;
  const bounceCount = rows.filter((r) => String(r.reason || '').includes('bounce')).length;

  return (
    <div className="stack">
      <div className="page-title"><h2>No Inbox / Bounced / Blocked</h2><p>Emails that failed delivery, were address-not-found, bounced, or were blocked by recipient/provider filters.</p></div>
      {recordsError ? <div className="error">{recordsError.message}</div> : null}
      {businessError ? <div className="error">{businessError.message}</div> : null}

      <div className="grid grid-4">
        <div className="card kpi"><div className="title">Tracked Records</div><div className="num">{rows.length.toLocaleString()}</div></div>
        <div className="card kpi"><div className="title">No Inbox</div><div className="num">{noInboxCount.toLocaleString()}</div></div>
        <div className="card kpi"><div className="title">Message Blocked</div><div className="num">{blockedCount.toLocaleString()}</div></div>
        <div className="card kpi"><div className="title">Bounces</div><div className="num">{bounceCount.toLocaleString()}</div></div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Gmail Delivery Failure Records</h3>
        <p className="muted">These come from Gmail sync. Message blocked is not always an invalid email; it usually means policy/spam/reputation filtering blocked delivery.</p>
        <div className="table-wrap"><table><thead><tr><th>Email</th><th>Business</th><th>Reason</th><th>Website</th><th>Gmail Thread</th><th>Created</th></tr></thead><tbody>
          {rows.map((r) => {
            const business = Array.isArray(r.businesses) ? r.businesses[0] : r.businesses;
            return <tr key={r.id}><td>{text(r.email)}</td><td>{r.business_id ? <Link href={`/businesses/${r.business_id}`}>{text(business?.name)}</Link> : text(business?.name)}</td><td>{text(r.reason)}</td><td>{text(business?.website || business?.domain)}</td><td>{text(r.gmail_thread_id)}</td><td>{r.created_at ? new Date(r.created_at).toLocaleString() : '-'}</td></tr>;
          })}
          {!rows.length ? <tr><td colSpan={6} className="muted">No Gmail delivery failure records yet. Run Replies → Sync replies + bounces, or Message → Sync Bounces/Blocked.</td></tr> : null}
        </tbody></table></div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Businesses Marked No Inbox / Bounced / Invalid</h3>
        <div className="table-wrap"><table><thead><tr><th>Business</th><th>Email</th><th>Website</th><th>Status</th><th>Updated</th></tr></thead><tbody>
          {fallbackBusinesses.map((b) => <tr key={b.id}><td><Link href={`/businesses/${b.id}`}>{text(b.name)}</Link></td><td>{text(b.email)}</td><td>{text(b.website || b.domain)}</td><td className={`status ${b.status}`}>{text(b.status)}</td><td>{b.updated_at ? new Date(b.updated_at).toLocaleString() : '-'}</td></tr>)}
          {!fallbackBusinesses.length ? <tr><td colSpan={5} className="muted">No businesses currently marked no_inbox, bounced, or invalid.</td></tr> : null}
        </tbody></table></div>
      </div>
    </div>
  );
}
