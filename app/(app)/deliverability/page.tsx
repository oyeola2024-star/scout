import Link from 'next/link';
import { createClient } from '@/lib/supabase-server';
import { getCurrentWorkspace } from '@/lib/workspace';

type AnyRow = Record<string, any>;

function pct(n: number, d: number) {
  if (!d) return '0%';
  return `${Math.round((n / d) * 1000) / 10}%`;
}

function cleanEmail(email: unknown) {
  return String(email || '').trim().toLowerCase();
}

function riskLabel(opts: { bounceRate: number; blocked: number; spamSeeds: number; limitNotices: number; realReplies: number; sent: number }) {
  if (opts.limitNotices > 0) return { label: 'Pause: Gmail limit', tone: 'danger' };
  if (opts.blocked > 0 || opts.spamSeeds > 0 || opts.bounceRate >= 8) return { label: 'High risk', tone: 'danger' };
  if (opts.bounceRate >= 3 || opts.sent > 150 && opts.realReplies === 0) return { label: 'Watch', tone: 'warn' };
  return { label: 'OK', tone: 'success' };
}

async function safeSelect<T = AnyRow>(promise: PromiseLike<{ data: T[] | null; error: any }>) {
  const { data, error } = await promise;
  if (error) return [] as T[];
  return (data || []) as T[];
}

export default async function DeliverabilityPage() {
  const { workspace } = await getCurrentWorkspace();
  const supabase = await createClient();
  if (!workspace) {
    return <div className="card"><h2>Deliverability</h2><p className="error">No workspace is available for this account.</p></div>;
  }

  const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const since1 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [accounts, sent, noInbox, replies, seedTests] = await Promise.all([
    safeSelect<AnyRow>(supabase.from('gmail_accounts').select('*').eq('workspace_id', workspace.id).order('created_at', { ascending: true })),
    safeSelect<AnyRow>(supabase.from('sent_messages').select('*').eq('workspace_id', workspace.id).gte('sent_at', since7).order('sent_at', { ascending: false }).limit(5000)),
    safeSelect<AnyRow>(supabase.from('no_inbox_records').select('*').eq('workspace_id', workspace.id).gte('created_at', since7).order('created_at', { ascending: false }).limit(5000)),
    safeSelect<AnyRow>(supabase.from('reply_history').select('*').eq('workspace_id', workspace.id).gte('received_at', since7).order('received_at', { ascending: false }).limit(5000)),
    safeSelect<AnyRow>(supabase.from('seed_inbox_tests').select('*').eq('workspace_id', workspace.id).gte('created_at', since7).order('created_at', { ascending: false }).limit(5000))
  ]);

  const bySender = accounts.map((account) => {
    const email = cleanEmail(account.email);
    const sentRows = sent.filter((row) => cleanEmail(row.from_email || row.raw?.from_email) === email || row.gmail_account_id === account.id);
    const inboxRows = noInbox.filter((row) => cleanEmail(row.from_email) === email || row.gmail_account_id === account.id);
    const replyRows = replies.filter((row) => cleanEmail(row.to_email) === email || row.gmail_account_id === account.id);
    const realReplies = replyRows.filter((row) => row.is_real_reply === true || row.reply_bucket === 'real_reply').length;
    const autoReplies = replyRows.filter((row) => row.is_auto_reply === true || row.reply_bucket === 'auto_reply').length;
    const blocked = inboxRows.filter((row) => String(row.reason || row.status || row.type || '').toLowerCase().includes('blocked')).length;
    const limitNotices = replyRows.filter((row) => row.is_limit_notice === true || String(row.reply_bucket || row.classification || '').toLowerCase().includes('limit')).length;
    const seedRows = seedTests.filter((row) => cleanEmail(row.sender_email) === email || row.sender_gmail_account_id === account.id);
    const spamSeeds = seedRows.filter((row) => String(row.placement || '').toLowerCase().includes('spam')).length;
    const todaySent = sentRows.filter((row) => String(row.sent_at || '') >= since1).length;
    const bounceRate = sentRows.length ? (inboxRows.length / sentRows.length) * 100 : 0;
    const risk = riskLabel({ bounceRate, blocked, spamSeeds, limitNotices, realReplies, sent: sentRows.length });
    return { account, email, sent: sentRows.length, todaySent, noInbox: inboxRows.length, blocked, realReplies, autoReplies, limitNotices, seedTests: seedRows.length, spamSeeds, bounceRate, risk };
  });

  const totalSent = sent.length;
  const totalNoInbox = noInbox.length;
  const totalRealReplies = replies.filter((row) => row.is_real_reply === true || row.reply_bucket === 'real_reply').length;
  const totalAutoReplies = replies.filter((row) => row.is_auto_reply === true || row.reply_bucket === 'auto_reply').length;
  const totalBlocked = noInbox.filter((row) => String(row.reason || row.status || row.type || '').toLowerCase().includes('blocked')).length;
  const totalSpamSeeds = seedTests.filter((row) => String(row.placement || '').toLowerCase().includes('spam')).length;

  return (
    <div className="stack">
      <div>
        <h2>Deliverability Dashboard</h2>
        <p className="muted">Use this page to see inbox problems, blocked messages, Gmail limit notices, and sender risk before a large run.</p>
      </div>

      <div className="grid grid-4">
        <div className="card kpi"><div className="title">Sent · 7 days</div><div className="num">{totalSent.toLocaleString()}</div><p className="muted">Tracked sent messages.</p></div>
        <div className="card kpi"><div className="title">No Inbox / Bounce</div><div className="num">{totalNoInbox.toLocaleString()}</div><p className="muted">Bounce rate: {pct(totalNoInbox, totalSent)}</p></div>
        <div className="card kpi"><div className="title">Replies</div><div className="num">{totalRealReplies.toLocaleString()}</div><p className="muted">Reply rate: {pct(totalRealReplies, totalSent)}</p></div>
        <div className="card kpi"><div className="title">Seed Spam Hits</div><div className="num">{totalSpamSeeds.toLocaleString()}</div><p className="muted">Blocked notices: {totalBlocked.toLocaleString()}</p></div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Sender Risk</h3>
        <p className="muted">No-inbox and blocked messages do not count as replies. Auto replies are tracked separately. A sender is risky if it gets Gmail limit notices, blocked messages, seed inbox spam placement, or high no-inbox/bounce rate.</p>
        <div className="table-wrap"><table><thead><tr><th>Sender</th><th>Status</th><th>Risk</th><th>Sent 7d</th><th>Sent 24h</th><th>No Inbox</th><th>Blocked</th><th>Replies</th><th>Auto-Like</th><th>Seed Spam</th><th>Action</th></tr></thead><tbody>
          {bySender.map((row) => <tr key={row.account.id}>
            <td><strong>{row.email}</strong><br /><span className="muted">Run cap: {row.account.default_run_limit || row.account.daily_limit || '-'}</span></td>
            <td>{row.account.status || '-'}</td>
            <td><span className={`status ${row.risk.tone === 'danger' ? 'failed' : row.risk.tone === 'warn' ? 'review' : 'ready'}`}>{row.risk.label}</span></td>
            <td>{row.sent}</td>
            <td>{row.todaySent}</td>
            <td>{row.noInbox} <span className="muted">({pct(row.noInbox, row.sent)})</span></td>
            <td>{row.blocked}</td>
            <td>{row.realReplies}</td>
            <td>{row.autoReplies}</td>
            <td>{row.spamSeeds}/{row.seedTests}</td>
            <td><Link href="/settings">Adjust sender</Link></td>
          </tr>)}
          {!bySender.length ? <tr><td colSpan={11} className="muted">No Gmail sender accounts found. Connect Gmail in Settings.</td></tr> : null}
        </tbody></table></div>
      </div>

      <div className="grid grid-2">
        <div className="card" style={{ padding: 18 }}>
          <h3>Recent Delivery Failures</h3>
          <div className="table-wrap"><table><thead><tr><th>Email</th><th>Reason</th><th>Sender</th><th>Time</th></tr></thead><tbody>
            {noInbox.slice(0, 20).map((row, index) => <tr key={row.id || index}><td>{row.email || row.to_email || '-'}</td><td>{row.reason || row.status || row.type || '-'}</td><td>{row.from_email || '-'}</td><td>{row.created_at ? new Date(row.created_at).toLocaleString() : '-'}</td></tr>)}
            {!noInbox.length ? <tr><td colSpan={4} className="muted">No delivery failures in the last 7 days.</td></tr> : null}
          </tbody></table></div>
        </div>
        <div className="card" style={{ padding: 18 }}>
          <h3>Recent Seed Inbox Tests</h3>
          <div className="table-wrap"><table><thead><tr><th>Sender</th><th>Seed</th><th>Placement</th><th>Time</th></tr></thead><tbody>
            {seedTests.slice(0, 20).map((row, index) => <tr key={row.id || index}><td>{row.sender_email || '-'}</td><td>{row.seed_email || '-'}</td><td>{row.placement || '-'}</td><td>{row.checked_at || row.created_at ? new Date(row.checked_at || row.created_at).toLocaleString() : '-'}</td></tr>)}
            {!seedTests.length ? <tr><td colSpan={4} className="muted">No seed tests yet. Go to Settings, mark one account as seed receiver, then run a seed test.</td></tr> : null}
          </tbody></table></div>
        </div>
      </div>

      <div className="notice">
        <strong>Rule for decisions:</strong> if a sender shows high no-inbox, blocked messages, spam seed placement, or Gmail limit notices, reduce that sender's max per run in <Link href="/settings">Settings</Link> before sending again.
      </div>
    </div>
  );
}
