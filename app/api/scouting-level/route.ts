export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { fetchUnifiedReplyMetrics } from '@/lib/reply-metrics';
import { requireWorkspaceAccess } from '@/lib/require-workspace-access';

const STAGES = [
  { name: 'Novice', min: 0 },
  { name: 'Rookie', min: 1_000 },
  { name: 'Apprentice', min: 12_000 },
  { name: 'Scout', min: 35_000 },
  { name: 'Pro Scout', min: 100_000 },
  { name: 'Strategist', min: 300_000 },
  { name: 'Operator', min: 900_000 },
  { name: 'Rainmaker', min: 2_500_000 },
  { name: 'Commander', min: 7_000_000 },
  { name: 'Master Scout', min: 18_000_000 },
  { name: 'Grandmaster', min: 50_000_000 },
  { name: 'Ultimate', min: 150_000_000 }
];

async function safeCount(supabase: any, table: string, workspaceId: string, build?: (query: any) => any) {
  try {
    let query = supabase.from(table).select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId);
    if (build) query = build(query);
    const { count } = await query;
    return Number(count || 0);
  } catch {
    return 0;
  }
}

function stageFor(points: number) {
  let currentIndex = 0;
  for (let i = 0; i < STAGES.length; i += 1) {
    if (points >= STAGES[i].min) currentIndex = i;
  }
  const current = STAGES[currentIndex];
  const next = STAGES[currentIndex + 1] || null;
  const progress = next ? Math.max(0, Math.min(100, Math.round(((points - current.min) / (next.min - current.min)) * 100))) : 100;
  return { current, next, progress, stageNumber: currentIndex + 1, totalStages: STAGES.length };
}

export async function GET(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get('workspaceId') || '';
  if (!workspaceId) return NextResponse.json({ success: false, error: 'workspaceId is required.' }, { status: 400 });
  try {
    await requireWorkspaceAccess(workspaceId);
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || 'Unauthorized.' }, { status: Number(error?.status || 403) });
  }
  const supabase = createAdminClient();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [
    deliveredMessages,
    sentToday,
    trustedEmails,
    autoScoutJobs,
    realReplies,
    realRepliesToday,
    manualReplies,
    gmailAccounts,
    templates,
    schedules,
    dueFollowups,
    noInboxRecords,
    appActivity,
    uniqueSenders,
    businesses
  ] = await Promise.all([
    safeCount(supabase, 'sent_messages', workspaceId, (q) => q.in('status', ['sent', 'delivered'])),
    safeCount(supabase, 'sent_messages', workspaceId, (q) => q.in('status', ['sent', 'delivered']).gte('sent_at', today.toISOString())),
    safeCount(supabase, 'businesses', workspaceId, (q) => q.not('email', 'is', null).neq('email', '').in('status', ['ready', 'found', 'connected'])),
    safeCount(supabase, 'email_research_jobs', workspaceId, (q) => q.in('status', ['done', 'found'])),
    Promise.resolve(0),
    Promise.resolve(0),
    safeCount(supabase, 'sent_messages', workspaceId, (q) => q.eq('delivery_status', 'manual_reply_sent')),
    safeCount(supabase, 'gmail_accounts', workspaceId, (q) => q.or('status.eq.connected,status.eq.active,status.eq.ready,status.is.null')),
    safeCount(supabase, 'templates', workspaceId, (q) => q.or('active.eq.true,is_active.eq.true,active.is.null,is_active.is.null')),
    safeCount(supabase, 'message_schedules', workspaceId, (q) => q.in('status', ['scheduled', 'due', 'running', 'completed'])),
    safeCount(supabase, 'message_schedules', workspaceId, (q) => q.in('status', ['due', 'running'])),
    safeCount(supabase, 'no_inbox_records', workspaceId),
    safeCount(supabase, 'activity_logs', workspaceId),
    safeCount(supabase, 'gmail_accounts', workspaceId, (q) => q.not('email', 'is', null).neq('email', '')),
    safeCount(supabase, 'businesses', workspaceId)
  ]);

  const [replyMetricsAll, replyMetricsToday] = await Promise.all([
    fetchUnifiedReplyMetrics(supabase, workspaceId),
    fetchUnifiedReplyMetrics(supabase, workspaceId, { start: today })
  ]);
  const unifiedRealReplies = replyMetricsAll.realReplies;
  const unifiedRealRepliesToday = replyMetricsToday.realReplies;

  // v10.15: level, dashboard, challenges, and replies all use the same one reply metric.

  // v10.11: Make levels genuinely hard. Scouting/import volume alone should
  // not push someone into higher mastery. Rough rule: 3,000 scouted leads with
  // little/no reply activity should feel like Rookie, not Strategist.
  // Replies and replies sent from Scout still matter the most,
  // but later stages require sustained volume and pipeline activity.
  const points = Math.round(
    deliveredMessages * 0.25 +
    Math.min(sentToday, 100_000) * 0.05 +
    trustedEmails * 0.3 +
    autoScoutJobs * 0.15 +
    Math.min(businesses, 1_000_000) * 0.005 +
    unifiedRealReplies * 1_500 +
    unifiedRealRepliesToday * 200 +
    manualReplies * 2_000 +
    Math.min(gmailAccounts, 300) * 400 +
    Math.min(uniqueSenders, 300) * 150 +
    Math.min(templates, 500) * 60 +
    Math.min(schedules, 1000) * 20 +
    Math.min(dueFollowups, 100_000) * 0.2 +
    Math.min(noInboxRecords, 250_000) * 0.02 +
    Math.min(appActivity, 3000) * 0.2
  );

  return NextResponse.json({
    success: true,
    points,
    ...stageFor(points),
    stages: STAGES.map((stage, index) => ({
      name: stage.name,
      stageNumber: index + 1,
      unlocked: points >= stage.min
    })),
    hints: [
      unifiedRealReplies < 10 ? 'Get more prospect replies. Replies move your level the most.' : null,
      manualReplies < Math.max(3, Math.floor(unifiedRealReplies * 0.25)) ? 'Reply to prospects from inside Scout. That shows real pipeline work.' : null,
      trustedEmails < 25_000 ? 'Use Auto Scout to build more trusted contact emails, but volume alone will not unlock high stages.' : null,
      deliveredMessages < 25_000 ? 'Send more clean messages from healthy Gmail accounts.' : null,
      templates < 10 ? 'Create stronger first-message and follow-up templates.' : null,
      gmailAccounts < 10 ? 'Connect more healthy sender accounts when you are ready to scale.' : null
    ].filter(Boolean),
    highlights: {
      deliveredMessages,
      sentToday,
      trustedEmails,
      autoScoutJobs,
      realReplies: unifiedRealReplies,
      realRepliesToday: unifiedRealRepliesToday,
      manualReplies,
      gmailAccounts,
      templates,
      schedules
    }
  });
}
