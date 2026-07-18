export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { getCurrentWorkspace } from '@/lib/workspace';
import { fetchUnifiedReplyMetrics } from '@/lib/reply-metrics';

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}
function csv(value: unknown) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function pct(current: number, previous: number) {
  if (!previous && !current) return '0%';
  if (!previous) return '+100%';
  const diff = ((current - previous) / previous) * 100;
  return `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%`;
}
async function count(table: string, workspaceId: string, column: string, start: Date, end: Date, filters: Array<{ column: string; value: unknown }> = []) {
  const supabase = await createClient();
  let query: any = supabase.from(table).select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).gte(column, start.toISOString()).lt(column, end.toISOString());
  for (const filter of filters) query = query.eq(filter.column, filter.value);
  const { count: total } = await query;
  return total || 0;
}

export async function GET() {
  const { workspace, error } = await getCurrentWorkspace();
  if (!workspace) return NextResponse.json({ success: false, error: error || 'No workspace.' }, { status: 401 });
  const now = new Date();
  const todayStart = startOfDay(now);
  const yesterdayStart = addDays(todayStart, -1);
  const todayEnd = addDays(todayStart, 1);

  const supabase = await createClient();
  const [scoutedToday, scoutedYesterday, sentToday, sentYesterday, todayReplyMetrics, yesterdayReplyMetrics, autoRepliesTodayRaw, autoRepliesYesterdayRaw, badToday, badYesterday] = await Promise.all([
    count('businesses', workspace.id, 'created_at', todayStart, todayEnd),
    count('businesses', workspace.id, 'created_at', yesterdayStart, todayStart),
    count('sent_messages', workspace.id, 'sent_at', todayStart, todayEnd, [{ column: 'status', value: 'sent' }]),
    count('sent_messages', workspace.id, 'sent_at', yesterdayStart, todayStart, [{ column: 'status', value: 'sent' }]),
    fetchUnifiedReplyMetrics(supabase, workspace.id, { start: todayStart, end: todayEnd }),
    fetchUnifiedReplyMetrics(supabase, workspace.id, { start: yesterdayStart, end: todayStart }),
    count('reply_history', workspace.id, 'received_at', todayStart, todayEnd, [{ column: 'is_auto_reply', value: true }]),
    count('reply_history', workspace.id, 'received_at', yesterdayStart, todayStart, [{ column: 'is_auto_reply', value: true }]),
    count('no_inbox_records', workspace.id, 'created_at', todayStart, todayEnd),
    count('no_inbox_records', workspace.id, 'created_at', yesterdayStart, todayStart)
  ]);
  const realRepliesToday = todayReplyMetrics.realReplies;
  const realRepliesYesterday = yesterdayReplyMetrics.realReplies;
  const autoRepliesToday = todayReplyMetrics.autoReplies || autoRepliesTodayRaw;
  const autoRepliesYesterday = yesterdayReplyMetrics.autoReplies || autoRepliesYesterdayRaw;

  const rows = [
    { metric: 'People scouted', today: scoutedToday, yesterday: scoutedYesterday, change: pct(scoutedToday, scoutedYesterday) },
    { metric: 'Messages sent', today: sentToday, yesterday: sentYesterday, change: pct(sentToday, sentYesterday) },
    { metric: 'Replies', today: realRepliesToday, yesterday: realRepliesYesterday, change: pct(realRepliesToday, realRepliesYesterday) },
    { metric: 'Auto replies', today: autoRepliesToday, yesterday: autoRepliesYesterday, change: pct(autoRepliesToday, autoRepliesYesterday) },
    { metric: 'No inbox / blocked', today: badToday, yesterday: badYesterday, change: pct(badToday, badYesterday) },
    { metric: 'Reply rate', today: sentToday ? `${((realRepliesToday / sentToday) * 100).toFixed(2)}%` : '0%', yesterday: sentYesterday ? `${((realRepliesYesterday / sentYesterday) * 100).toFixed(2)}%` : '0%', change: pct(sentToday ? realRepliesToday / sentToday : 0, sentYesterday ? realRepliesYesterday / sentYesterday : 0) }
  ];
  const lines = [['metric','today','yesterday','change'].join(',')];
  for (const row of rows) lines.push([csv(row.metric), csv(row.today), csv(row.yesterday), csv(row.change)].join(','));
  return new NextResponse(lines.join('\n'), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="scout-today-report-${todayStart.toISOString().slice(0,10)}.csv"` } });
}
