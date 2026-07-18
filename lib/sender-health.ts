import type { SupabaseClient } from '@supabase/supabase-js';

export type SenderHealthStage =
  | 'assessment'
  | 'restricted'
  | 'recovering'
  | 'stable'
  | 'established'
  | 'healthy'
  | 'proven'
  | 'paused';

export type SenderHealthEventType =
  | 'send_success'
  | 'permanent_bounce'
  | 'temporary_failure'
  | 'provider_limit'
  | 'message_blocked'
  | 'seed_spam'
  | 'real_reply'
  | 'manual_pause'
  | 'manual_resume'
  | 'temporary_resume';

type AnyRow = Record<string, any>;
type IssueKind = 'provider_limit' | 'temporary_failure' | 'message_blocked' | 'permanent_bounce' | 'seed_spam';

const FORWARD_STAGES: SenderHealthStage[] = [
  'assessment',
  'recovering',
  'stable',
  'established',
  'healthy',
  'proven',
];

const DAY = 24 * 60 * 60 * 1000;
const ISSUE_WINDOW_MS = 14 * DAY;

const ISSUE_POLICIES: Record<IssueKind, {
  label: string;
  ordinaryPauseMs: number | null;
  hardRestrictionMs: number | null;
  recoveringCap: number;
}> = {
  provider_limit: {
    label: 'Gmail provider sending limit',
    ordinaryPauseMs: DAY,
    hardRestrictionMs: 7 * DAY,
    recoveringCap: 50,
  },
  temporary_failure: {
    label: 'Repeated temporary delivery failures',
    ordinaryPauseMs: 30 * 60 * 1000,
    hardRestrictionMs: 3 * DAY,
    recoveringCap: 50,
  },
  message_blocked: {
    label: 'Messages blocked by Gmail or the receiving provider',
    ordinaryPauseMs: 60 * 60 * 1000,
    hardRestrictionMs: 7 * DAY,
    recoveringCap: 50,
  },
  permanent_bounce: {
    label: 'Permanent bounces / invalid recipient list',
    ordinaryPauseMs: null,
    hardRestrictionMs: null,
    recoveringCap: 25,
  },
  seed_spam: {
    label: 'Repeated seed tests landing in Spam',
    ordinaryPauseMs: DAY,
    hardRestrictionMs: 14 * DAY,
    recoveringCap: 25,
  },
};

export function deploymentDailyCap() {
  const parsed = Number(process.env.SCOUT_DEPLOYMENT_DAILY_CAP || 250);
  if (!Number.isFinite(parsed)) return 250;
  return Math.max(1, Math.min(300, Math.floor(parsed)));
}

export function deploymentRunCap() {
  return deploymentDailyCap();
}

export function assessmentCheckpointCap(successfulSends: number, deploymentCap = deploymentDailyCap()) {
  const success = Math.max(0, Number(successfulSends || 0));
  if (success < 25) return Math.min(deploymentCap, 25);
  if (success < 50) return Math.min(deploymentCap, 50);
  if (success < 100) return Math.min(deploymentCap, 100);
  if (success < 150) return Math.min(deploymentCap, 150);
  return deploymentCap;
}

export function stageCap(stage: string, successfulSends = 0, deploymentCap = deploymentDailyCap()) {
  const normalized = String(stage || 'assessment').toLowerCase() as SenderHealthStage;
  const caps: Record<SenderHealthStage, number> = {
    assessment: assessmentCheckpointCap(successfulSends, deploymentCap),
    restricted: 50,
    recovering: 75,
    stable: 100,
    established: 150,
    healthy: 200,
    proven: deploymentCap,
    paused: 0,
  };
  return Math.max(0, Math.min(deploymentCap, caps[normalized] ?? caps.assessment));
}

export function effectiveDailyLimit(account: AnyRow) {
  const deploymentCap = Math.max(1, Math.min(300, Number(account.deployment_cap || deploymentDailyCap())));
  const healthCap = Math.max(0, Math.min(deploymentCap, Number(account.health_cap ?? stageCap(account.health_stage, account.successful_sends, deploymentCap))));
  const userCap = Math.max(1, Math.min(deploymentCap, Number(account.daily_limit || deploymentCap)));
  return Math.max(0, Math.min(deploymentCap, healthCap, userCap));
}

export function effectiveRunLimit(account: AnyRow) {
  const daily = effectiveDailyLimit(account);
  const systemRunCap = Math.max(1, Number(account.deployment_run_cap || deploymentRunCap()));
  const preferred = Math.max(1, Number(account.default_run_limit || systemRunCap));
  return Math.max(0, Math.min(daily, systemRunCap, preferred));
}

export function randomSenderCooldownSeconds() {
  return 90 + Math.floor(Math.random() * 121);
}

export function randomWorkspaceDispatchGapSeconds() {
  return 3 + Math.floor(Math.random() * 4);
}

export function issuePolicy(kind: string) {
  return ISSUE_POLICIES[kind as IssueKind] || null;
}

function pauseWarning(account: AnyRow) {
  return String(account.paused_reason || account.health_reason || account.last_error || 'Scout paused this Gmail account for safety.');
}

function oneStepUp(current: SenderHealthStage, candidate: SenderHealthStage) {
  if (candidate === 'restricted' || candidate === 'paused') return candidate;
  const currentIndex = FORWARD_STAGES.indexOf(current);
  const candidateIndex = FORWARD_STAGES.indexOf(candidate);
  if (candidateIndex < 0 || currentIndex < 0 || candidateIndex <= currentIndex) return candidate;
  return FORWARD_STAGES[Math.min(candidateIndex, currentIndex + 1)];
}

function issueKindFromEvent(eventType: SenderHealthEventType): IssueKind | null {
  if (eventType === 'provider_limit') return 'provider_limit';
  if (eventType === 'temporary_failure') return 'temporary_failure';
  if (eventType === 'message_blocked') return 'message_blocked';
  if (eventType === 'permanent_bounce') return 'permanent_bounce';
  if (eventType === 'seed_spam') return 'seed_spam';
  return null;
}

function issueStrike(account: AnyRow, kind: IssueKind, nowMs: number) {
  const sameIssue = String(account.pause_issue_key || '') === kind;
  const windowStartMs = account.pause_issue_window_started_at
    ? new Date(account.pause_issue_window_started_at).getTime()
    : 0;
  const withinWindow = sameIssue && windowStartMs > 0 && nowMs - windowStartMs <= ISSUE_WINDOW_MS;
  return {
    count: withinWindow ? Number(account.pause_issue_count || 0) + 1 : 1,
    windowStartedAt: new Date(withinWindow ? windowStartMs : nowMs).toISOString(),
    windowEndsAt: new Date((withinWindow ? windowStartMs : nowMs) + ISSUE_WINDOW_MS).toISOString(),
  };
}

function formatRestrictionDuration(ms: number | null) {
  if (ms === null) return 'until the recipient list is cleaned';
  const days = Math.round(ms / DAY);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.round(ms / (60 * 60 * 1000));
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function issuePausePatch(account: AnyRow, kind: IssueKind, reason: string, nowMs = Date.now()) {
  const policy = ISSUE_POLICIES[kind];
  const strike = issueStrike(account, kind, nowMs);
  const hardRestricted = strike.count >= 3;
  const hardUntil = hardRestricted && policy.hardRestrictionMs !== null
    ? new Date(nowMs + policy.hardRestrictionMs).toISOString()
    : null;
  const ordinaryUntil = !hardRestricted && policy.ordinaryPauseMs !== null
    ? new Date(nowMs + policy.ordinaryPauseMs).toISOString()
    : null;
  const baseReason = reason || policy.label;
  const consequence = hardRestricted
    ? `This is occurrence 3 within 14 days. Scout hard-restricted this Gmail ${formatRestrictionDuration(policy.hardRestrictionMs)}.`
    : `This is occurrence ${strike.count} of 3 within the current 14-day issue window. The user may resume after acknowledging this warning; the same issue will pause it again.`;

  return {
    health_stage: 'restricted' as SenderHealthStage,
    health_cap: 0,
    health_reason: `${baseReason} ${consequence}`,
    is_paused: true,
    status: kind === 'provider_limit' ? 'limit_hit' : 'paused',
    pause_kind: kind,
    paused_until: hardRestricted ? hardUntil : ordinaryUntil,
    paused_reason: `${baseReason} ${consequence}`,
    safety_override_active: false,
    safety_override_until: null,
    safety_override_warning: null,
    pause_issue_key: kind,
    pause_issue_count: strike.count,
    pause_issue_window_started_at: strike.windowStartedAt,
    pause_issue_window_ends_at: strike.windowEndsAt,
    pause_issue_last_at: new Date(nowMs).toISOString(),
    hard_restriction_active: hardRestricted,
    hard_restricted_until: hardUntil,
    hard_restriction_reason: hardRestricted ? `${policy.label}: repeated 3 times within 14 days.` : null,
    hard_restriction_count: hardRestricted ? Number(account.hard_restriction_count || 0) + 1 : Number(account.hard_restriction_count || 0),
    updated_at: new Date(nowMs).toISOString(),
    last_health_review_at: new Date(nowMs).toISOString(),
  };
}

export async function recordSenderHealthEvent(
  supabase: SupabaseClient<any, any, any>,
  input: {
    workspaceId: string;
    gmailAccountId: string;
    eventType: SenderHealthEventType;
    reason?: string;
    recipient?: string;
    raw?: Record<string, unknown>;
  },
) {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  await supabase.from('sender_health_events').insert({
    workspace_id: input.workspaceId,
    gmail_account_id: input.gmailAccountId,
    event_type: input.eventType,
    reason: input.reason || null,
    recipient_email: input.recipient || null,
    raw: input.raw || {},
    created_at: now,
  });

  const { data: account } = await supabase
    .from('gmail_accounts')
    .select('*')
    .eq('workspace_id', input.workspaceId)
    .eq('id', input.gmailAccountId)
    .maybeSingle();
  if (!account) return null;

  const patch: AnyRow = { updated_at: now, last_health_review_at: now };
  const overrideWasActive = Boolean(account.safety_override_active);
  const currentStage = String(account.health_stage || 'assessment') as SenderHealthStage;
  const issueKind = issueKindFromEvent(input.eventType);

  if (input.eventType === 'provider_limit') {
    Object.assign(patch, issuePausePatch(account, 'provider_limit', input.reason || 'Gmail provider limit detected.', nowMs));
    patch.provider_limit_events = Number(account.provider_limit_events || 0) + 1;
    patch.last_provider_limit_at = now;
    patch.clean_since = now;
  } else if (input.eventType === 'permanent_bounce') {
    patch.permanent_bounces = Number(account.permanent_bounces || 0) + 1;
    patch.health_reason = input.reason || 'Permanent delivery failure detected.';
  } else if (input.eventType === 'temporary_failure') {
    patch.temporary_failures = Number(account.temporary_failures || 0) + 1;
    patch.health_reason = input.reason || 'Temporary delivery failure detected.';
  } else if (input.eventType === 'message_blocked') {
    patch.blocked_events = Number(account.blocked_events || 0) + 1;
    patch.health_reason = input.reason || 'Message was blocked by Gmail or the receiving provider.';
  } else if (input.eventType === 'seed_spam') {
    patch.health_reason = input.reason || 'A seed placement test landed in Spam.';
  } else if (input.eventType === 'real_reply') {
    patch.real_replies = Number(account.real_replies || 0) + 1;
  } else if (input.eventType === 'manual_pause') {
    Object.assign(patch, {
      health_stage: 'paused',
      health_cap: 0,
      is_paused: true,
      status: 'paused',
      pause_kind: 'manual',
      paused_until: null,
      paused_reason: input.reason || 'Paused manually.',
      health_reason: input.reason || 'Paused manually.',
      safety_override_active: false,
      safety_override_until: null,
      safety_override_warning: null,
    });
  } else if (input.eventType === 'manual_resume') {
    Object.assign(patch, {
      health_stage: currentStage === 'paused' ? 'assessment' : currentStage,
      health_cap: stageCap(currentStage === 'paused' ? 'assessment' : currentStage, Number(account.successful_sends || 0), Number(account.deployment_cap || deploymentDailyCap())),
      is_paused: false,
      status: 'connected',
      pause_kind: null,
      paused_until: null,
      paused_reason: null,
      safety_override_active: false,
      safety_override_until: null,
      safety_override_warning: null,
      health_reason: 'Manual pause ended by the user.',
    });
  } else if (input.eventType === 'temporary_resume') {
    const warning = input.reason || pauseWarning(account);
    Object.assign(patch, {
      is_paused: false,
      status: 'connected',
      health_stage: 'recovering',
      health_cap: Math.min(Number(account.deployment_cap || deploymentDailyCap()), 50),
      safety_override_active: true,
      safety_override_until: null,
      safety_override_warning: warning,
      safety_override_acknowledged_at: now,
      health_reason: `Resumed with warning. Original reason: ${warning}`,
    });
  }

  if (overrideWasActive && issueKind && input.eventType !== 'provider_limit') {
    const base = {
      ...account,
      ...patch,
      safety_override_active: true,
    };
    Object.assign(patch, issuePausePatch(base, issueKind, input.reason || patch.health_reason || ISSUE_POLICIES[issueKind].label, nowMs));
  }

  await supabase
    .from('gmail_accounts')
    .update(patch)
    .eq('workspace_id', input.workspaceId)
    .eq('id', input.gmailAccountId);

  if (!overrideWasActive && ['permanent_bounce', 'temporary_failure', 'message_blocked', 'seed_spam', 'real_reply'].includes(input.eventType)) {
    const { data: updated } = await supabase
      .from('gmail_accounts')
      .select('*')
      .eq('workspace_id', input.workspaceId)
      .eq('id', input.gmailAccountId)
      .maybeSingle();
    if (updated) return reviewSenderHealth(supabase, updated);
  }

  return patch;
}

export async function reviewSenderHealth(
  supabase: SupabaseClient<any, any, any>,
  account: AnyRow,
) {
  const accountId = String(account.id);
  const workspaceId = String(account.workspace_id);
  const now = new Date();
  const nowMs = now.getTime();
  const since24h = new Date(nowMs - DAY).toISOString();
  const since14d = new Date(nowMs - 14 * DAY).toISOString();

  const hardActive = Boolean(account.hard_restriction_active);
  const hardUntilMs = account.hard_restricted_until ? new Date(account.hard_restricted_until).getTime() : 0;
  if (hardActive) {
    if (!hardUntilMs || hardUntilMs > nowMs) {
      const patch = {
        health_stage: 'restricted',
        health_cap: 0,
        is_paused: true,
        status: 'paused',
        health_reason: account.hard_restriction_reason || account.paused_reason || 'This Gmail is hard-restricted.',
        last_health_review_at: now.toISOString(),
        updated_at: now.toISOString(),
      };
      await supabase.from('gmail_accounts').update(patch).eq('workspace_id', workspaceId).eq('id', accountId);
      return patch;
    }

    const unlockPatch = {
      hard_restriction_active: false,
      hard_restricted_until: null,
      hard_restriction_reason: null,
      pause_issue_count: 0,
      pause_issue_key: null,
      pause_issue_window_started_at: null,
      pause_issue_window_ends_at: null,
      pause_kind: null,
      paused_until: null,
      paused_reason: null,
      safety_override_active: false,
      safety_override_warning: null,
      is_paused: false,
      status: 'connected',
      health_stage: 'recovering',
      health_cap: Math.min(Number(account.deployment_cap || deploymentDailyCap()), 25),
      health_reason: 'The hard restriction ended. Scout restarted this Gmail in Recovering stage at 25/day.',
      last_stage_change_at: now.toISOString(),
      last_health_review_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    await supabase.from('gmail_accounts').update(unlockPatch).eq('workspace_id', workspaceId).eq('id', accountId);
    return unlockPatch;
  }

  if (String(account.pause_kind || '') === 'manual' && account.is_paused) {
    return {
      health_stage: 'paused',
      health_cap: 0,
      health_reason: account.paused_reason || 'Paused manually.',
      is_paused: true,
      pause_kind: 'manual',
      paused_until: null,
      status: 'paused',
    };
  }

  const automaticPause = Boolean(account.pause_kind && String(account.pause_kind) !== 'manual');
  const warningResume = Boolean(account.safety_override_active);
  const timedPauseExpired = automaticPause
    && account.paused_until
    && new Date(account.paused_until).getTime() <= nowMs
    && String(account.pause_kind) !== 'permanent_bounce';

  if (automaticPause && warningResume) {
    const patch = {
      health_stage: 'recovering',
      health_cap: Math.min(Number(account.deployment_cap || deploymentDailyCap()), 50),
      health_reason: `Resumed with warning. Original reason: ${account.safety_override_warning || pauseWarning(account)}`,
      is_paused: false,
      status: 'connected',
      last_health_review_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    await supabase.from('gmail_accounts').update(patch).eq('workspace_id', workspaceId).eq('id', accountId);
    return patch;
  }

  if (automaticPause && !timedPauseExpired) {
    const patch = {
      health_stage: 'restricted',
      health_cap: 0,
      health_reason: account.paused_reason || account.health_reason || 'Scout paused this Gmail for safety.',
      is_paused: true,
      status: account.pause_kind === 'provider_limit' ? 'limit_hit' : 'paused',
      last_health_review_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    await supabase.from('gmail_accounts').update(patch).eq('workspace_id', workspaceId).eq('id', accountId);
    return patch;
  }

  if (timedPauseExpired) {
    account = {
      ...account,
      pause_kind: null,
      paused_until: null,
      paused_reason: null,
      is_paused: false,
      status: 'connected',
      health_stage: 'recovering',
      health_cap: Math.min(Number(account.deployment_cap || deploymentDailyCap()), 50),
      health_reason: 'The timed safety pause ended. Scout restarted this Gmail in Recovering stage.',
    };
  }

  const { data: events } = await supabase
    .from('sender_health_events')
    .select('event_type,created_at')
    .eq('workspace_id', workspaceId)
    .eq('gmail_account_id', accountId)
    .gte('created_at', since24h)
    .order('created_at', { ascending: false })
    .limit(200);

  const recent = (events || []) as AnyRow[];
  const sent = recent.filter((row) => row.event_type === 'send_success').length;
  const permanent = recent.filter((row) => row.event_type === 'permanent_bounce').length;
  const temporary = recent.filter((row) => row.event_type === 'temporary_failure').length;
  const blocked = recent.filter((row) => row.event_type === 'message_blocked').length;
  const replies24h = recent.filter((row) => row.event_type === 'real_reply').length;
  const attempts = Math.max(1, sent + permanent + temporary + blocked);
  const permanentRate = permanent / attempts;
  const temporaryRate = temporary / attempts;
  const blockedRate = blocked / attempts;

  const { count: recentProviderLimits } = await supabase
    .from('sender_health_events')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('gmail_account_id', accountId)
    .eq('event_type', 'provider_limit')
    .gte('created_at', since14d);

  const { data: seedRows } = await supabase
    .from('seed_inbox_tests')
    .select('placement,checked_at,created_at')
    .eq('workspace_id', workspaceId)
    .eq('sender_gmail_account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(3);
  const recentPlacements = (seedRows || []).map((row: AnyRow) => String(row.placement || '').toLowerCase());
  const consecutiveSpam = recentPlacements.findIndex((value: string) => value !== 'spam');
  const spamRun = recentPlacements.length && consecutiveSpam === -1 ? recentPlacements.length : Math.max(0, consecutiveSpam);

  if (blockedRate > 0.10) {
    const patch = issuePausePatch(account, 'message_blocked', `Message-block rate is ${(blockedRate * 100).toFixed(1)}%.`, nowMs);
    await supabase.from('gmail_accounts').update(patch).eq('workspace_id', workspaceId).eq('id', accountId);
    return patch;
  }
  if (permanentRate > 0.05) {
    const patch = issuePausePatch(account, 'permanent_bounce', `Permanent bounce rate is ${(permanentRate * 100).toFixed(1)}%. Clean the recipient list before resuming.`, nowMs);
    await supabase.from('gmail_accounts').update(patch).eq('workspace_id', workspaceId).eq('id', accountId);
    return patch;
  }
  if (temporaryRate > 0.15) {
    const patch = issuePausePatch(account, 'temporary_failure', `Temporary failure rate is ${(temporaryRate * 100).toFixed(1)}%.`, nowMs);
    await supabase.from('gmail_accounts').update(patch).eq('workspace_id', workspaceId).eq('id', accountId);
    return patch;
  }

  const deploymentCap = Math.max(1, Math.min(300, Number(account.deployment_cap || deploymentDailyCap())));
  const totalSuccess = Number(account.successful_sends || 0);
  const totalRealReplies = Number(account.real_replies || 0);
  const createdAt = new Date(account.created_at || now).getTime();
  const ageDays = Math.max(0, (nowMs - createdAt) / DAY);
  const currentStage = String(account.health_stage || 'assessment') as SenderHealthStage;
  let candidate: SenderHealthStage = currentStage;
  let candidateReason = 'Health is within the current stage thresholds.';

  if ((recentProviderLimits || 0) > 0) {
    candidate = 'restricted';
    candidateReason = 'A Gmail provider-limit event occurred during the previous 14 days.';
  } else if (spamRun >= 3) {
    candidate = 'restricted';
    candidateReason = 'Three consecutive seed tests landed in Spam. Scout reduced this sender to 50/day.';
  } else if (blockedRate >= 0.05) {
    candidate = 'restricted';
    candidateReason = `Message-block rate is ${(blockedRate * 100).toFixed(1)}%; sender reduced to Restricted.`;
  } else if (permanentRate >= 0.03) {
    candidate = 'restricted';
    candidateReason = `Permanent bounce rate is ${(permanentRate * 100).toFixed(1)}%; sender reduced to Restricted.`;
  } else if (ageDays < 2 || totalSuccess < 50) {
    candidate = 'assessment';
    candidateReason = replies24h > 0
      ? 'Sender is in checkpoint-controlled assessment and has received a real reply.'
      : 'Sender is in checkpoint-controlled assessment.';
  } else if (totalSuccess >= 500 && totalRealReplies === 0) {
    candidate = 'stable';
    candidateReason = 'Scout is holding this sender at 100/day because 500 successful sends produced no confirmed real reply.';
  } else if (ageDays >= 21 && totalSuccess >= 2000 && totalRealReplies >= 5) {
    candidate = 'proven';
    candidateReason = 'At least 21 days, 2,000 successful sends, five real replies and no recent provider limit.';
  } else if (ageDays >= 14 && totalSuccess >= 1000 && totalRealReplies >= 3) {
    candidate = 'healthy';
    candidateReason = 'At least 14 clean days, 1,000 successful sends and three real replies.';
  } else if (ageDays >= 7 && totalSuccess >= 400 && totalRealReplies >= 1) {
    candidate = 'established';
    candidateReason = 'At least seven days, 400 successful sends and a confirmed real reply.';
  } else if (totalSuccess >= 100 || (ageDays >= 2 && totalSuccess >= 75 && totalRealReplies >= 1)) {
    candidate = 'stable';
    candidateReason = totalRealReplies > 0
      ? 'Clean delivery activity and confirmed real replies support Stable.'
      : 'At least 100 successful sends with acceptable delivery results.';
  } else {
    candidate = 'recovering';
    candidateReason = 'Sender needs more clean sending history.';
  }

  if (spamRun === 2 && candidate !== 'restricted') {
    const idx = FORWARD_STAGES.indexOf(candidate);
    candidate = idx > 0 ? FORWARD_STAGES[idx - 1] : candidate;
    candidateReason = 'Two consecutive seed tests landed in Spam. Scout reduced this sender by one stage.';
  } else if (spamRun === 1) {
    const currentIndex = FORWARD_STAGES.indexOf(currentStage);
    const candidateIndex = FORWARD_STAGES.indexOf(candidate);
    if (candidateIndex > currentIndex && currentIndex >= 0) candidate = currentStage;
    candidateReason = 'The latest seed test landed in Spam. Scout froze automatic increases.';
  }

  const isIncrease = FORWARD_STAGES.indexOf(candidate) > FORWARD_STAGES.indexOf(currentStage);
  const lastStageChange = account.last_stage_change_at ? new Date(account.last_stage_change_at).getTime() : 0;
  if (isIncrease) {
    if (lastStageChange && nowMs - lastStageChange < DAY) {
      candidate = currentStage;
      candidateReason = 'Scout allows at most one automatic stage increase in 24 hours.';
    } else {
      candidate = oneStepUp(currentStage, candidate);
    }
  }

  const stageChanged = candidate !== currentStage;
  const patch: AnyRow = {
    health_stage: candidate,
    health_cap: stageCap(candidate, totalSuccess, deploymentCap),
    health_reason: candidateReason,
    is_paused: false,
    pause_kind: null,
    paused_until: null,
    paused_reason: null,
    safety_override_active: false,
    safety_override_until: null,
    safety_override_warning: null,
    last_health_review_at: now.toISOString(),
    updated_at: now.toISOString(),
    status: 'connected',
  };
  if (stageChanged) patch.last_stage_change_at = now.toISOString();

  await supabase.from('gmail_accounts').update(patch).eq('workspace_id', workspaceId).eq('id', accountId);
  return patch;
}
