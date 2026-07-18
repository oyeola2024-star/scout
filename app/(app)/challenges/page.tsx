import ChallengeBoard from '@/components/ChallengeBoard';
import { createClient } from '@/lib/supabase-server';
import { getCurrentWorkspace } from '@/lib/workspace';
import { fetchUnifiedReplyMetrics } from '@/lib/reply-metrics';

export const dynamic = 'force-dynamic';

export type MetricKey =
  | 'deliveredMessages'
  | 'realReplies'
  | 'realRepliesToday'
  | 'trustedEmails'
  | 'gmailAccounts'
  | 'templates'
  | 'sentToday'
  | 'dueFollowups'
  | 'schedules'
  | 'autoScoutJobs'
  | 'manualReplies';

export type Challenge = {
  id: string;
  icon: string;
  title: string;
  metric: MetricKey;
  target: number;
  tier: 'Starter' | 'Growth' | 'Boss' | 'Legend';
  steps: string[];
};

function tierFor(target: number, easy: number, growth: number, boss: number): Challenge['tier'] {
  if (target <= easy) return 'Starter';
  if (target <= growth) return 'Growth';
  if (target <= boss) return 'Boss';
  return 'Legend';
}

function milestones(
  slug: string,
  prefix: string,
  icon: string,
  metric: MetricKey,
  values: number[],
  steps: string[],
  tierBreaks: { easy: number; growth: number; boss: number }
): Challenge[] {
  return values.map((target) => ({
    id: `${slug}-${target}`,
    icon,
    title: `${prefix} ${target.toLocaleString()}`,
    metric,
    target,
    tier: tierFor(target, tierBreaks.easy, tierBreaks.growth, tierBreaks.boss),
    steps
  }));
}

const sendSteps = [
  'Go to Send Emails.',
  'Choose the audience and country you want.',
  'Choose the correct first-message template.',
  'Choose one sender or rotate many Gmail accounts.',
  'Click Send Now and keep Scout open while it sends.'
];

const trustedEmailSteps = [
  'Go to Find Leads.',
  'Open Find missing emails.',
  'Click Start finding emails.',
  'Let Scout check the business websites.',
  'Trusted emails are saved so you can use them later.'
];

const challenges: Challenge[] = [
  // Only a few quick wins. The rest are meant to stretch users for days, weeks, or months.
  ...milestones('starter-sent', 'First delivery goal', '📨', 'deliveredMessages', [250, 1000], sendSteps, { easy: 250, growth: 1000, boss: 1000 }),
  ...milestones('starter-replies', 'First reply goal', '💬', 'realReplies', [1, 5], [
    'Send useful emails to the right leads.',
    'Go to Replies later.',
    'Sync replies.',
    'Only human-looking replies count here. Ticket receipts and auto messages do not count.'
  ], { easy: 1, growth: 5, boss: 5 }),
  ...milestones('starter-trusted', 'First trusted emails', '🔎', 'trustedEmails', [500, 1000], trustedEmailSteps, { easy: 500, growth: 1000, boss: 1000 }),
  ...milestones('starter-gmail', 'Connect Gmail accounts', '📮', 'gmailAccounts', [1, 5], [
    'Go to Settings.',
    'Open Gmail accounts.',
    'Connect each Gmail account you want Scout to use.',
    'Set a safe daily limit for every sender.'
  ], { easy: 1, growth: 5, boss: 5 }),
  ...milestones('starter-templates', 'Create message templates', '✍️', 'templates', [1, 5], [
    'Go to Templates.',
    'Create first-message templates and follow-up templates.',
    'Use clear messages that sound human.'
  ], { easy: 1, growth: 5, boss: 5 }),

  // Scale sending.
  ...milestones('delivered', 'Send delivered messages', '🚀', 'deliveredMessages', [5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000, 10000000], sendSteps, { easy: 0, growth: 50000, boss: 1000000 }),
  ...milestones('sent-today', 'Send in one day', '⚡', 'sentToday', [5000, 10000, 20000, 35000, 50000, 75000, 100000], [
    'Go to Send Emails early in the day.',
    'Use many healthy Gmail accounts.',
    'Use safe delays and sender limits.',
    'Keep Scout open while sending.'
  ], { easy: 0, growth: 10000, boss: 50000 }),

  // Replies. Auto replies are removed from challenges.
  ...milestones('real-replies-today', 'Get replies in one day', '🔥', 'realRepliesToday', [10, 20, 30, 50, 100], [
    'Send useful messages to a clean list.',
    'Check Replies after sending.',
    'Sync replies.',
    'Every non-bounce reply counts here.'
  ], { easy: 0, growth: 30, boss: 100 }),
  ...milestones('real-replies', 'Get replies', '🏆', 'realReplies', [10, 20, 30, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000], [
    'Send useful emails to the right leads.',
    'Keep your message simple and specific.',
    'Go to Replies and sync replies.',
    'Auto messages, bounces, and no-inbox messages do not count here.'
  ], { easy: 0, growth: 100, boss: 2500 }),

  // Auto Scout and email quality.
  ...milestones('trusted-emails', 'Find trusted emails', '💎', 'trustedEmails', [5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000], trustedEmailSteps, { easy: 0, growth: 50000, boss: 500000 }),
  ...milestones('auto-scout-work', 'Run Auto Scout checks', '🧭', 'autoScoutJobs', [10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000], [
    'Go to Find Leads.',
    'Click Find missing emails.',
    'Start finding emails.',
    'Results appear on the same page and trusted emails are saved.'
  ], { easy: 0, growth: 100000, boss: 1000000 }),

  // Account and template scale.
  ...milestones('gmail-scale', 'Connect Gmail accounts', '📮', 'gmailAccounts', [10, 20, 30, 50, 75, 100, 150, 200, 300], [
    'Go to Settings.',
    'Connect another Gmail account.',
    'Set a safe daily limit.',
    'Repeat until you have enough healthy senders.'
  ], { easy: 0, growth: 50, boss: 150 }),
  ...milestones('template-scale', 'Create message templates', '✍️', 'templates', [10, 20, 30, 50, 100, 250, 500], [
    'Go to Templates.',
    'Create clear first-message templates.',
    'Create follow-up templates.',
    'Create reply templates for prospect replies.'
  ], { easy: 0, growth: 50, boss: 250 }),

  // Follow-up and response workflow.
  ...milestones('due-followups', 'Have due follow-ups ready', '↩️', 'dueFollowups', [500, 1000, 2500, 5000, 10000, 25000, 50000], [
    'Send first messages.',
    'Wait 72 hours.',
    'Go to Send Emails, then Due Follow-ups.',
    'Choose the follow-up template and send when ready.'
  ], { easy: 0, growth: 5000, boss: 25000 }),
  ...milestones('manual-replies', 'Reply to prospects from Scout', '✉️', 'manualReplies', [1, 5, 10, 20, 50, 100, 250, 500, 1000, 5000], [
    'Go to Replies.',
    'Open a prospect reply.',
    'Choose or write a reply message.',
    'Send the reply from Scout.'
  ], { easy: 1, growth: 50, boss: 500 }),
  ...milestones('schedules', 'Save sends for later', '⏰', 'schedules', [10, 25, 50, 100, 250, 500, 1000], [
    'Go to Send Emails.',
    'Choose audience, template, sender, and count.',
    'Pick a date and time.',
    'Save the schedule.',
    'Open Scout when it is time and run due sends.'
  ], { easy: 0, growth: 100, boss: 500 })
];

async function safeCount(table: string, workspaceId: string, build?: (query: any) => any) {
  try {
    const supabase = await createClient();
    let query: any = supabase.from(table).select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId);
    if (build) query = build(query);
    const { count } = await query;
    return count || 0;
  } catch {
    return 0;
  }
}

async function loadMetrics(workspaceId: string): Promise<Record<MetricKey, number>> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const deliveredMessages = await safeCount('sent_messages', workspaceId, (q) => q.in('status', ['sent', 'delivered']));
  const sentToday = await safeCount('sent_messages', workspaceId, (q) => q.in('status', ['sent', 'delivered']).gte('sent_at', today.toISOString()));
  const supabaseForReplies = await createClient();
  const replyMetricsAll = await fetchUnifiedReplyMetrics(supabaseForReplies, workspaceId);
  const replyMetricsToday = await fetchUnifiedReplyMetrics(supabaseForReplies, workspaceId, { start: today });
  const realReplies = replyMetricsAll.realReplies;
  const trustedEmails = await safeCount('businesses', workspaceId, (q) => q.not('email', 'is', null).neq('email', '').in('status', ['ready', 'found', 'connected']));
  const gmailAccounts = await safeCount('gmail_accounts', workspaceId, (q) => q.or('status.eq.connected,status.eq.active,status.is.null'));
  const templates = await safeCount('templates', workspaceId, (q) => q.or('active.eq.true,is_active.eq.true,active.is.null,is_active.is.null'));
  const schedules = await safeCount('message_schedules', workspaceId, (q) => q.in('status', ['scheduled', 'due', 'running', 'completed']));
  const autoScoutJobs = await safeCount('email_research_jobs', workspaceId, (q) => q.in('status', ['done', 'found']));
  const manualReplies = await safeCount('sent_messages', workspaceId, (q) => q.eq('delivery_status', 'manual_reply_sent'));

  let dueFollowups = 0;
  try {
    const supabase = await createClient();
    const { data } = await supabase.rpc('get_due_followups', {
      target_workspace: workspaceId,
      limit_rows: 5000,
      followup_segment: 'all_unanswered'
    });
    dueFollowups = Array.isArray(data) ? data.length : 0;
  } catch {
    dueFollowups = 0;
  }

  const realRepliesToday = replyMetricsToday.realReplies;

  return { deliveredMessages, realReplies, realRepliesToday, trustedEmails, gmailAccounts, templates, sentToday, dueFollowups, schedules, autoScoutJobs, manualReplies };
}

export default async function ChallengesPage() {
  const { workspace, error } = await getCurrentWorkspace();
  if (!workspace) return <div className="error">Workspace error: {error}</div>;
  const metrics = await loadMetrics(workspace.id);
  return <ChallengeBoard challenges={challenges} metrics={metrics} />;
}
