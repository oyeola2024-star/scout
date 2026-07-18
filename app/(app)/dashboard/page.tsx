import Link from 'next/link';
import { createClient } from '@/lib/supabase-server';
import { getCurrentWorkspace } from '@/lib/workspace';
import SendTimeStrip from '@/components/SendTimeStrip';
import { REPLY_METRIC_SELECT, fetchUnifiedReplyMetrics, isUnifiedRealReply } from '@/lib/reply-metrics';

type RangeKey = 'today' | 'yesterday' | 'last7' | 'last30' | 'last90' | 'all';

type DashboardSearchParams = Promise<{ range?: string }> | { range?: string } | undefined;

type CountFilter = { column: string; value: unknown };
type DateWindow = { start?: Date; end?: Date };

type PeriodDefinition = {
  key: RangeKey;
  label: string;
  shortLabel: string;
  current: DateWindow;
  previous?: DateWindow;
  compareLabel: string;
};

const rangeOptions: Array<{ key: RangeKey; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'last90', label: 'Last 3 months' },
  { key: 'all', label: 'All time' }
];

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function periodFor(key: string | undefined): PeriodDefinition {
  const selected = rangeOptions.some((option) => option.key === key) ? (key as RangeKey) : 'today';
  const now = new Date();
  const todayStart = startOfDay(now);
  const yesterdayStart = addDays(todayStart, -1);
  const twoDaysAgo = addDays(todayStart, -2);

  if (selected === 'yesterday') {
    return {
      key: 'yesterday',
      label: 'Yesterday',
      shortLabel: 'Yesterday',
      current: { start: yesterdayStart, end: todayStart },
      previous: { start: twoDaysAgo, end: yesterdayStart },
      compareLabel: 'vs previous day'
    };
  }

  if (selected === 'last7') {
    const start = addDays(now, -7);
    const previousStart = addDays(start, -7);
    return {
      key: 'last7',
      label: 'Last 7 days',
      shortLabel: '7 days',
      current: { start, end: now },
      previous: { start: previousStart, end: start },
      compareLabel: 'vs previous 7 days'
    };
  }

  if (selected === 'last30') {
    const start = addDays(now, -30);
    const previousStart = addDays(start, -30);
    return {
      key: 'last30',
      label: 'Last 30 days',
      shortLabel: '30 days',
      current: { start, end: now },
      previous: { start: previousStart, end: start },
      compareLabel: 'vs previous 30 days'
    };
  }

  if (selected === 'last90') {
    const start = addDays(now, -90);
    const previousStart = addDays(start, -90);
    return {
      key: 'last90',
      label: 'Last 3 months',
      shortLabel: '3 months',
      current: { start, end: now },
      previous: { start: previousStart, end: start },
      compareLabel: 'vs previous 3 months'
    };
  }

  if (selected === 'all') {
    return {
      key: 'all',
      label: 'All time',
      shortLabel: 'All time',
      current: {},
      compareLabel: 'no comparison'
    };
  }

  return {
    key: 'today',
    label: 'Today',
    shortLabel: 'Today',
    current: { start: todayStart, end: now },
    previous: { start: yesterdayStart, end: todayStart },
    compareLabel: 'vs yesterday'
  };
}

function applyDateRange(query: any, dateColumn: string | undefined, window?: DateWindow) {
  if (!dateColumn || !window) return query;
  if (window.start) query = query.gte(dateColumn, window.start.toISOString());
  if (window.end) query = query.lt(dateColumn, window.end.toISOString());
  return query;
}

async function countRows(
  table: string,
  workspaceId: string,
  options?: { filters?: CountFilter[]; inFilters?: Array<{ column: string; values: unknown[] }>; dateColumn?: string; window?: DateWindow }
) {
  const supabase = await createClient();
  let query: any = supabase.from(table).select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId);
  for (const filter of options?.filters || []) query = query.eq(filter.column, filter.value);
  for (const filter of options?.inFilters || []) query = query.in(filter.column, filter.values as any[]);
  query = applyDateRange(query, options?.dateColumn, options?.window);
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}

async function safeCount(
  table: string,
  workspaceId: string,
  options?: { filters?: CountFilter[]; inFilters?: Array<{ column: string; values: unknown[] }>; dateColumn?: string; window?: DateWindow }
) {
  try {
    return await countRows(table, workspaceId, options);
  } catch {
    return 0;
  }
}

function pctChange(current: number, previous: number) {
  if (previous === 0 && current === 0) return { text: 'No change', tone: 'muted' as const };
  if (previous === 0) return { text: `+${current.toLocaleString()} new`, tone: 'ok' as const };
  const diff = current - previous;
  const pct = (diff / previous) * 100;
  const sign = diff >= 0 ? '+' : '';
  return {
    text: `${sign}${diff.toLocaleString()} (${sign}${pct.toFixed(1)}%)`,
    tone: diff >= 0 ? ('ok' as const) : ('bad' as const)
  };
}

function toneStyle(tone: 'ok' | 'bad' | 'muted') {
  if (tone === 'ok') return { color: 'var(--ok)' };
  if (tone === 'bad') return { color: 'var(--bad)' };
  return { color: 'var(--muted)' };
}

function ratio(numerator: number, denominator: number, decimals = 1) {
  return denominator ? `${((numerator / denominator) * 100).toFixed(decimals)}%` : '0%';
}

function emailsPerReply(sent: number, replies: number) {
  return replies ? (sent / replies).toFixed(1) : '-';
}


function SetupChecklist({ tasks }: { tasks: Array<{ title: string; href: string; done: boolean; hint: string }> }) {
  const done = tasks.filter((task) => task.done).length;
  return (
    <div className="card" style={{ padding: 18 }}>
      <div className="actions" style={{ justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h3 style={{ margin: 0 }}>Setup checklist</h3>
          <p className="muted" style={{ margin: '6px 0 0' }}>Do these in order. Scout marks each step when it sees the result.</p>
        </div>
        <span className="badge">{done} / {tasks.length} complete</span>
      </div>
      <div className="setup-list" style={{ marginTop: 14 }}>
        {tasks.map((task, index) => (
          <Link href={task.href} className={`setup-item ${task.done ? 'done' : ''}`} key={task.title}>
            <span className="setup-check">{task.done ? '✓' : index + 1}</span>
            <span><strong>{task.title}</strong><small>{task.hint}</small></span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function NextActionCard({ title, href, helper }: { title: string; href: string; helper: string }) {
  return (
    <Link className="quick-link-card big-action" href={href}>
      <strong>{title}</strong>
      <span>{helper}</span>
    </Link>
  );
}

function KpiCard({ title, value, previous, compareLabel, helper }: { title: string; value: number | string; previous?: number; compareLabel?: string; helper?: string }) {
  const numeric = typeof value === 'number' ? value : null;
  const change = numeric !== null && previous !== undefined ? pctChange(numeric, previous) : null;
  return (
    <div className="card kpi">
      <div className="title">{title}</div>
      <div className="num">{typeof value === 'number' ? value.toLocaleString() : value}</div>
      {change ? <div style={{ marginTop: 8, fontSize: 12, fontWeight: 900, ...toneStyle(change.tone) }}>{change.text}</div> : null}
      {compareLabel ? <div className="muted" style={{ marginTop: 3, fontSize: 12 }}>{compareLabel}</div> : null}
      {helper ? <div className="muted" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.45 }}>{helper}</div> : null}
    </div>
  );
}

async function fetchPeriodMessages(workspaceId: string, period: PeriodDefinition) {
  const supabase = await createClient();
  let sentQuery: any = supabase
    .from('sent_messages')
    .select('id, template_id, gmail_account_id')
    .eq('workspace_id', workspaceId)
    .eq('status', 'sent')
    .limit(10000);
  sentQuery = applyDateRange(sentQuery, 'sent_at', period.current);
  const { data: sentRows } = await sentQuery;

  let replyQuery: any = supabase
    .from('reply_history')
    .select(REPLY_METRIC_SELECT)
    .eq('workspace_id', workspaceId)
    .limit(10000);
  replyQuery = applyDateRange(replyQuery, 'received_at', period.current);
  const { data: rawReplyRows } = await replyQuery;
  const replyRows = (rawReplyRows || []).filter(isUnifiedRealReply);

  const templateIds = Array.from(new Set([...(sentRows || []).map((row: any) => row.template_id), ...(replyRows || []).map((row: any) => row.template_id)].filter(Boolean)));
  const senderIds = Array.from(new Set([...(sentRows || []).map((row: any) => row.gmail_account_id), ...(replyRows || []).map((row: any) => row.gmail_account_id)].filter(Boolean)));

  const templateNames = new Map<string, string>();
  const activeTemplateIds = new Set<string>();
  const senderEmails = new Map<string, string>();

  // Only current active templates appear in performance. Archived/deleted/old versions are hidden.
  const { data: activeTemplates } = await supabase
    .from('templates')
    .select('id,name')
    .eq('workspace_id', workspaceId)
    .eq('active', true)
    .limit(1000);
  for (const row of activeTemplates || []) {
    if (row.id) {
      activeTemplateIds.add(row.id);
      templateNames.set(row.id, row.name || 'Untitled template');
    }
  }

  if (templateIds.length && !activeTemplateIds.size) {
    const { data } = await supabase.from('templates').select('id,name').eq('workspace_id', workspaceId).in('id', templateIds).eq('active', true);
    for (const row of data || []) {
      activeTemplateIds.add(row.id);
      templateNames.set(row.id, row.name || 'Untitled template');
    }
  }
  if (senderIds.length) {
    const { data } = await supabase.from('gmail_accounts').select('id,email').eq('workspace_id', workspaceId).in('id', senderIds);
    for (const row of data || []) senderEmails.set(row.id, row.email || 'Unknown sender');
  }

  const templateMap = new Map<string, { id: string; name: string; sent: number; replies: number }>();
  const senderMap = new Map<string, { id: string; email: string; sent: number; replies: number }>();

  for (const [id, name] of templateNames.entries()) {
    templateMap.set(id, { id, name, sent: 0, replies: 0 });
  }

  for (const row of sentRows || []) {
    const tid = row.template_id || '';
    const sid = row.gmail_account_id || 'none';
    if (tid && activeTemplateIds.has(tid)) {
      const t = templateMap.get(tid) || { id: tid, name: templateNames.get(tid) || 'Untitled template', sent: 0, replies: 0 };
      t.sent += 1;
      templateMap.set(tid, t);
    }
    const s = senderMap.get(sid) || { id: sid, email: sid === 'none' ? 'No sender tracked' : (senderEmails.get(sid) || 'Unknown sender'), sent: 0, replies: 0 };
    s.sent += 1;
    senderMap.set(sid, s);
  }

  for (const row of replyRows || []) {
    const tid = row.template_id || '';
    const sid = row.gmail_account_id || 'none';
    if (tid && activeTemplateIds.has(tid)) {
      const t = templateMap.get(tid) || { id: tid, name: templateNames.get(tid) || 'Untitled template', sent: 0, replies: 0 };
      t.replies += 1;
      templateMap.set(tid, t);
    }
    const s = senderMap.get(sid) || { id: sid, email: sid === 'none' ? 'No sender tracked' : (senderEmails.get(sid) || 'Unknown sender'), sent: 0, replies: 0 };
    s.replies += 1;
    senderMap.set(sid, s);
  }

  return {
    templates: Array.from(templateMap.values()).sort((a, b) => (b.sent - a.sent) || (b.replies - a.replies) || a.name.localeCompare(b.name)).slice(0, 10),
    senders: Array.from(senderMap.values()).sort((a, b) => b.sent - a.sent).slice(0, 10)
  };
}


async function safeMissingEmailCount(workspaceId: string) {
  try {
    const supabase = await createClient();
    const { count, error } = await supabase
      .from('businesses')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .or('email.is.null,email.eq.')
      .not('status', 'in', '(contacted,responded,bad_inbox,bounced,no_inbox,blocked,invalid,duplicate,archived,unsubscribed,do_not_contact,sent)');
    if (error) throw error;
    return count || 0;
  } catch {
    return 0;
  }
}

export default async function DashboardPage({ searchParams }: { searchParams?: DashboardSearchParams }) {
  const params = await Promise.resolve(searchParams || {});
  const period = periodFor((params as any).range);
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: profileRows } = user
    ? await supabase.from('profiles').select('full_name').eq('id', user.id).limit(1)
    : { data: [] as Array<{ full_name?: string | null }> };
  const metadata = (user?.user_metadata || {}) as Record<string, unknown>;
  const fullName = String(profileRows?.[0]?.full_name || metadata.full_name || metadata.name || '').trim();
  const emailName = String(user?.email || '').split('@')[0].trim();
  const welcomeName = (fullName || emailName || 'there').split(/\s+/)[0];

  const { workspace, error } = await getCurrentWorkspace();
  if (!workspace) return <div className="error">Workspace error: {error}</div>;

  const previous = period.previous;
  const [
    totalBusinesses,
    currentPending,
    currentReady,
    currentContacted,
    currentResponded,
    periodImported,
    prevImported,
    periodFoundEmails,
    prevFoundEmails,
    periodResearchDone,
    prevResearchDone,
    periodSent,
    prevSent,
    periodRepliesRaw,
    prevRepliesRaw,
    periodNoInbox,
    prevNoInbox,
    scheduled,
    gmailConnected,
    initialTemplates,
    followUpTemplates,
    totalSentAll,
    autoRepliesAll,
    totalResearchDoneAll,
    manualRepliesAll
  ] = await Promise.all([
    safeCount('businesses', workspace.id),
    safeMissingEmailCount(workspace.id),
    safeCount('businesses', workspace.id, { filters: [{ column: 'status', value: 'ready' }] }),
    safeCount('businesses', workspace.id, { filters: [{ column: 'status', value: 'contacted' }] }),
    safeCount('businesses', workspace.id, { filters: [{ column: 'status', value: 'responded' }] }),
    safeCount('businesses', workspace.id, { dateColumn: 'created_at', window: period.current }),
    previous ? safeCount('businesses', workspace.id, { dateColumn: 'created_at', window: previous }) : Promise.resolve(0),
    safeCount('email_candidates', workspace.id, { dateColumn: 'created_at', window: period.current }),
    previous ? safeCount('email_candidates', workspace.id, { dateColumn: 'created_at', window: previous }) : Promise.resolve(0),
    safeCount('email_research_jobs', workspace.id, { filters: [{ column: 'status', value: 'done' }], dateColumn: 'finished_at', window: period.current }),
    previous ? safeCount('email_research_jobs', workspace.id, { filters: [{ column: 'status', value: 'done' }], dateColumn: 'finished_at', window: previous }) : Promise.resolve(0),
    safeCount('sent_messages', workspace.id, { filters: [{ column: 'status', value: 'sent' }], dateColumn: 'sent_at', window: period.current }),
    previous ? safeCount('sent_messages', workspace.id, { filters: [{ column: 'status', value: 'sent' }], dateColumn: 'sent_at', window: previous }) : Promise.resolve(0),
    safeCount('reply_history', workspace.id, { filters: [{ column: 'is_real_reply', value: true }], dateColumn: 'received_at', window: period.current }),
    previous ? safeCount('reply_history', workspace.id, { filters: [{ column: 'is_real_reply', value: true }], dateColumn: 'received_at', window: previous }) : Promise.resolve(0),
    safeCount('no_inbox_records', workspace.id, { dateColumn: 'created_at', window: period.current }),
    previous ? safeCount('no_inbox_records', workspace.id, { dateColumn: 'created_at', window: previous }) : Promise.resolve(0),
    safeCount('message_schedules', workspace.id, { filters: [{ column: 'status', value: 'scheduled' }] }),
    safeCount('gmail_accounts', workspace.id, { inFilters: [{ column: 'status', values: ['connected', 'active'] }] }),
    safeCount('templates', workspace.id, { filters: [{ column: 'template_type', value: 'initial' }] }),
    safeCount('templates', workspace.id, { filters: [{ column: 'template_type', value: 'follow_up' }] }),
    safeCount('sent_messages', workspace.id, { inFilters: [{ column: 'status', values: ['sent', 'delivered'] }] }),
    safeCount('reply_history', workspace.id, { filters: [{ column: 'is_auto_reply', value: true }] }),
    safeCount('email_research_jobs', workspace.id, { filters: [{ column: 'status', value: 'done' }] }),
    safeCount('sent_messages', workspace.id, { filters: [{ column: 'delivery_status', value: 'manual_reply_sent' }] })
  ]);

  const [allReplyMetrics, periodReplyMetrics, previousReplyMetrics] = await Promise.all([
    fetchUnifiedReplyMetrics(supabase, workspace.id),
    fetchUnifiedReplyMetrics(supabase, workspace.id, { start: period.current.start, end: period.current.end }),
    previous ? fetchUnifiedReplyMetrics(supabase, workspace.id, { start: previous.start, end: previous.end }) : Promise.resolve({ realReplies: 0, autoReplies: 0, deliveryFailures: 0, limitNotices: 0, totalInbound: 0, recentRowsChecked: 0 })
  ]);
    const periodReplies = periodReplyMetrics.realReplies;
  const prevReplies = previousReplyMetrics.realReplies;

  let dueFollowups = 0;
  try {
    const { data } = await supabase.rpc('get_due_followups', { target_workspace: workspace.id, limit_rows: 5000 });
    dueFollowups = (data || []).length;
  } catch {}

  let scheduleRows: any[] = [];
  try {
    const { data } = await supabase
      .from('message_schedules')
      .select('id,type,status,target_count,scheduled_for,raw')
      .eq('workspace_id', workspace.id)
      .in('status', ['scheduled', 'due', 'running'])
      .order('scheduled_for', { ascending: true })
      .limit(8);
    scheduleRows = data || [];
  } catch {}

  const periodPerformance = await fetchPeriodMessages(workspace.id, period).catch(() => ({ templates: [], senders: [] }));
  const periodResponseRate = ratio(periodReplies, periodSent);
  const periodEmailsPerReply = emailsPerReply(periodSent, periodReplies);
  const workspaceAny = workspace as any;
  const hasSignature = Boolean(workspaceAny.email_signature_text || workspaceAny.email_signature_html || workspaceAny.email_logo_url);
  const setupTasks = [
    { title: 'Connect your Gmail accounts', href: '/settings', done: gmailConnected > 0, hint: 'Scout needs at least one Gmail account before it can send.' },
    { title: 'Add your signature and logo', href: '/settings', done: hasSignature, hint: 'This goes at the bottom of your emails.' },
    { title: 'Add your first-message templates', href: '/templates', done: initialTemplates > 0, hint: 'These are used for new leads.' },
    { title: 'Add your follow-up templates', href: '/templates', done: followUpTemplates > 0, hint: 'These are used after 72 hours with no reply.' },
    { title: 'Import your lead list', href: '/upload', done: totalBusinesses > 0, hint: 'Upload CSV leads before searching or sending.' },
    { title: 'Find emails with Auto Scout', href: '/auto-scout', done: totalResearchDoneAll > 0, hint: 'Scout checks websites for missing emails.' },
    { title: 'Get trusted emails ready', href: '/verify', done: currentReady > 0, hint: 'Trusted leads are the safe list for sending.' },
    { title: 'Send your first message', href: '/message', done: totalSentAll > 0, hint: 'Send Now works while Scout is open.' },
    { title: 'Check real replies', href: '/replies', done: periodReplies > 0, hint: 'Scout shows human-looking replies separately from auto messages.' },
    { title: 'Respond to a prospect from Scout', href: '/replies', done: manualRepliesAll > 0, hint: 'Open a reply and send your answer from Scout.' },
    { title: 'Send due follow-ups', href: '/message', done: dueFollowups === 0 && totalSentAll > 0, hint: 'After 72 hours, choose a follow-up template and send due follow-ups.' },
    { title: 'Save one send for later', href: '/message', done: scheduled > 0, hint: 'Use this when timing matters by country.' }
  ];
  return (
    <div className="stack">
      <div className="topbar">
        <div className="page-title">
          <h2>Welcome, {welcomeName}</h2>
          <p>Your simple control center. See the important numbers first, then choose the next action.</p>
        </div>
        <span className="badge">Workspace: {workspace.name}</span>
      </div>

      <details className="card" style={{ padding: 16 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 900 }}>Check best sending time</summary>
        <div style={{ marginTop: 12 }}><SendTimeStrip /></div>
      </details>

      <div className="quick-links">
        <NextActionCard title="Find missing emails" href="/auto-scout" helper="Use Auto Scout and see results on the same page." />
        <NextActionCard title="Send emails" href="/message" helper="Pick audience, template, sender, and click Send Now." />
        <NextActionCard title="Send due follow-ups" href="/message" helper="Use the follow-up template and send when ready." />
        <NextActionCard title="Try challenges" href="/challenges" helper="Click a goal and Scout shows exact steps." />
      </div>

      <div className="card" style={{ padding: 16 }}>
        <div className="actions" style={{ justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: 0 }}>Analytics filter</h3>
            <p className="muted" style={{ margin: '6px 0 0' }}>Showing {period.label}. Comparisons use the matching previous period.</p>
          </div>
          <div className="actions">
            <a className="btn secondary" href="/api/reports/today">Download today report</a>
            {rangeOptions.map((option) => (
              <Link
                key={option.key}
                className={`btn ${period.key === option.key ? '' : 'secondary'}`}
                href={`/dashboard?range=${option.key}`}
                style={{ padding: '9px 12px' }}
              >
                {option.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-4">
        <KpiCard title="Total Businesses" value={totalBusinesses} helper="Every business or lead saved in this workspace." />
        <KpiCard title="Needs Email" value={currentPending} helper="Same as Missing emails on Find Missing Emails: leads with no usable email yet." />
        <KpiCard title="Ready To Email" value={currentReady} helper="These are leads you can send messages to right now." />
        <KpiCard title={`Real Replies (${period.shortLabel})`} value={periodReplies} previous={previous ? prevReplies : undefined} compareLabel={period.compareLabel} helper="Human-looking replies only. Auto replies, tickets, receipts, bounces, and no-inbox messages are not counted here." />
      </div>

      <div className="grid grid-4">
        <KpiCard title={`Messages Sent (${period.shortLabel})`} value={periodSent} previous={previous ? prevSent : undefined} compareLabel={period.compareLabel} />
        <KpiCard title="Real Reply Rate" value={periodResponseRate} helper={`${periodReplies.toLocaleString()} real replies from ${periodSent.toLocaleString()} sent messages.`} />
        <KpiCard title="Emails / Real Reply" value={periodEmailsPerReply} helper="How many emails you send to get one real reply. Lower is better." />
        <KpiCard title={`No Inbox / Bounces (${period.shortLabel})`} value={periodNoInbox} previous={previous ? prevNoInbox : undefined} compareLabel={period.compareLabel} />
      </div>

      <div className="grid grid-4">
        <KpiCard title={`Auto Scout Found Emails (${period.shortLabel})`} value={periodFoundEmails} previous={previous ? prevFoundEmails : undefined} compareLabel={period.compareLabel} />
        <KpiCard title={`Auto Scout Completed (${period.shortLabel})`} value={periodResearchDone} previous={previous ? prevResearchDone : undefined} compareLabel={period.compareLabel} />
        <KpiCard title="Due Follow-ups" value={dueFollowups} helper="People you messaged 72+ hours ago who have not replied yet." />
        <KpiCard title="Saved Sends" value={scheduled} helper="Messages saved to send later while Scout is open." />
      </div>

      <SetupChecklist tasks={setupTasks} />

      <div className="grid grid-2">
        <div className="card" style={{ padding: 18 }}>
          <h3>Template Performance — {period.label}</h3>
          <p className="muted" style={{ marginTop: -4 }}>Filtered by sent/reply dates in the selected period.</p>
          <div className="table-wrap"><table><thead><tr><th>Template</th><th>Sent</th><th>Real Replies</th><th>Real Reply Rate</th><th>Emails / Real Reply</th></tr></thead><tbody>
            {(periodPerformance.templates || []).map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.sent.toLocaleString()}</td><td>{row.replies.toLocaleString()}</td><td>{ratio(row.replies, row.sent)}</td><td>{emailsPerReply(row.sent, row.replies)}</td></tr>)}
            {!(periodPerformance.templates || []).length ? <tr><td colSpan={5} className="muted">No template performance in this period yet.</td></tr> : null}
          </tbody></table></div>
        </div>

        <div className="card" style={{ padding: 18 }}>
          <h3>Sender Performance — {period.label}</h3>
          <p className="muted" style={{ marginTop: -4 }}>Filtered by sent/reply dates in the selected period.</p>
          <div className="table-wrap"><table><thead><tr><th>Sender</th><th>Sent</th><th>Real Replies</th><th>Real Reply Rate</th><th>Emails / Real Reply</th></tr></thead><tbody>
            {(periodPerformance.senders || []).map((row) => <tr key={row.id}><td>{row.email}</td><td>{row.sent.toLocaleString()}</td><td>{row.replies.toLocaleString()}</td><td>{ratio(row.replies, row.sent)}</td><td>{emailsPerReply(row.sent, row.replies)}</td></tr>)}
            {!(periodPerformance.senders || []).length ? <tr><td colSpan={5} className="muted">No sender performance in this period yet.</td></tr> : null}
          </tbody></table></div>
        </div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <h3>Upcoming Message Schedules</h3>
        <div className="table-wrap"><table><thead><tr><th>Type</th><th>Date</th><th>Count</th><th>Status</th></tr></thead><tbody>
          {(scheduleRows || []).map((row: any) => <tr key={row.id}><td>{row.type}</td><td>{new Date(row.scheduled_for).toLocaleString()}</td><td>{Number(row.target_count || 0).toLocaleString()}</td><td>{row.status}</td></tr>)}
          {!(scheduleRows || []).length ? <tr><td colSpan={4} className="muted">No scheduled messages yet.</td></tr> : null}
        </tbody></table></div>
      </div>
    </div>
  );
}
