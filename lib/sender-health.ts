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
  | 'real_reply'
  | 'manual_pause'
  | 'manual_resume'
  | 'temporary_resume';

type AnyRow = Record<string, any>;

const FORWARD_STAGES: SenderHealthStage[] = [
  'assessment',
  'recovering',
  'stable',
  'established',
  'healthy',
  'proven',
];

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
  return 90 + Math.floor(Math.random() * 121); // 90–210 seconds, average 150 seconds.
}

export function randomWorkspaceDispatchGapSeconds() {
  return 3 + Math.floor(Math.random() * 4); // 3–6 seconds between different Gmail accounts.
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
  const now = new Date().toISOString();
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
  const overrideWasActive = Boolean(account.safety_override_until && new Date(account.safety_override_until).getTime() > Date.now());
  const currentStage = String(account.health_stage || 'assessment') as SenderHealthStage;

  if (input.eventType === 'provider_limit') {
    patch.health_stage = 'restricted';
    patch.health_cap = Math.min(Number(account.deployment_cap || deploymentDailyCap()), 50);
    patch.provider_limit_events = Number(account.provider_limit_events || 0) + 1;
    patch.last_provider_limit_at = now;
    patch.clean_since = now;
    patch.health_reason = input.reason || 'Gmail provider limit detected.';
    patch.is_paused = true;
    patch.status = 'limit_hit';
    patch.pause_kind = 'provider_limit';
    patch.paused_until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    patch.paused_reason = patch.health_reason;
    patch.safety_override_until = null;
    patch.safety_override_warning = null;
  } else if (input.eventType === 'permanent_bounce') {
    patch.permanent_bounces = Number(account.permanent_bounces || 0) + 1;
    patch.health_reason = input.reason || 'Permanent delivery failure detected.';
  } else if (input.eventType === 'temporary_failure') {
    patch.temporary_failures = Number(account.temporary_failures || 0) + 1;
    patch.health_reason = input.reason || 'Temporary delivery failure detected.';
  } else if (input.eventType === 'message_blocked') {
    patch.blocked_events = Number(account.blocked_events || 0) + 1;
    patch.health_reason = input.reason || 'Message was blocked by Gmail.';
  } else if (input.eventType === 'real_reply') {
    patch.real_replies = Number(account.real_replies || 0) + 1;
  } else if (input.eventType === 'manual_pause') {
    patch.health_stage = 'paused';
    patch.health_cap = 0;
    patch.is_paused = true;
    patch.status = 'paused';
    patch.pause_kind = 'manual';
    patch.paused_until = null;
    patch.paused_reason = input.reason || 'Paused manually.';
    patch.health_reason = patch.paused_reason;
    patch.safety_override_until = null;
    patch.safety_override_warning = null;
  } else if (input.eventType === 'manual_resume') {
    patch.health_stage = currentStage === 'paused' ? 'assessment' : currentStage;
    patch.health_cap = stageCap(patch.health_stage, Number(account.successful_sends || 0), Number(account.deployment_cap || deploymentDailyCap()));
    patch.is_paused = false;
    patch.status = 'connected';
    patch.pause_kind = null;
    patch.paused_until = null;
    patch.paused_reason = null;
    patch.safety_override_until = null;
    patch.safety_override_warning = null;
    patch.health_reason = 'Resumed manually.';
  } else if (input.eventType === 'temporary_resume') {
    const warning = input.reason || pauseWarning(account);
    patch.is_paused = false;
    patch.status = 'connected';
    patch.safety_override_until = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    patch.safety_override_warning = warning;
    patch.safety_override_acknowledged_at = now;
    patch.health_reason = `Temporary resume active. Original warning: ${warning}`;
  }

  // A new delivery problem while a safety override is active ends the override
  // immediately. This keeps temporary resume useful for a controlled test without
  // silently ignoring the reason Scout paused the Gmail account.
  if (overrideWasActive && ['permanent_bounce', 'temporary_failure', 'message_blocked'].includes(input.eventType)) {
    const rules = input.eventType === 'permanent_bounce'
      ? { kind: 'permanent_bounce', until: null, stage: 'restricted', reason: input.reason || 'A permanent bounce occurred during temporary resume. Clean the recipient list before resuming.' }
      : input.eventType === 'temporary_failure'
        ? { kind: 'temporary_failure', until: new Date(Date.now() + 30 * 60 * 1000).toISOString(), stage: 'recovering', reason: input.reason || 'A temporary delivery failure occurred during temporary resume. Scout paused the sender again for 30 minutes.' }
        : { kind: 'message_blocked', until: new Date(Date.now() + 60 * 60 * 1000).toISOString(), stage: 'restricted', reason: input.reason || 'Gmail blocked a message during temporary resume. Scout paused the sender again for one hour.' };
    patch.is_paused = true;
    patch.status = 'paused';
    patch.pause_kind = rules.kind;
    patch.paused_until = rules.until;
    patch.paused_reason = rules.reason;
    patch.health_reason = rules.reason;
    patch.health_stage = rules.stage;
    patch.health_cap = rules.stage === 'recovering' ? Math.min(deploymentDailyCap(), 75) : Math.min(deploymentDailyCap(), 50);
    patch.safety_override_until = null;
    patch.safety_override_warning = null;
  }

  await supabase
    .from('gmail_accounts')
    .update(patch)
    .eq('workspace_id', input.workspaceId)
    .eq('id', input.gmailAccountId);

  if (!overrideWasActive && ['permanent_bounce', 'temporary_failure', 'message_blocked', 'real_reply'].includes(input.eventType)) {
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
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const since14d = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const { data: events } = await supabase
    .from('sender_health_events')
    .select('event_type,created_at')
    .eq('workspace_id', workspaceId)
    .eq('gmail_account_id', accountId)
    .gte('created_at', since24h)
    .order('created_at', { ascending: false })
    .limit(200);

  const rows = events || [];
  const successes = rows.filter((r: AnyRow) => r.event_type === 'send_success').length;
  const permanent = rows.filter((r: AnyRow) => r.event_type === 'permanent_bounce').length;
  const temporary = rows.filter((r: AnyRow) => r.event_type === 'temporary_failure').length;
  const blocked = rows.filter((r: AnyRow) => r.event_type === 'message_blocked').length;
  const replies24h = rows.filter((r: AnyRow) => r.event_type === 'real_reply').length;
  const attempts = Math.max(1, successes + permanent + temporary + blocked);
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

  const deploymentCap = Math.max(1, Math.min(300, Number(account.deployment_cap || deploymentDailyCap())));
  const totalSuccess = Number(account.successful_sends || 0);
  const totalRealReplies = Number(account.real_replies || 0);
  const createdAt = new Date(account.created_at || now).getTime();
  const ageDays = Math.max(0, (now.getTime() - createdAt) / 86_400_000);
  const currentStage = String(account.health_stage || 'assessment') as SenderHealthStage;
  let stage: SenderHealthStage = currentStage;
  let reason = 'Health is within the current stage thresholds.';
  let pausedUntil: string | null = account.paused_until || null;
  let isPaused = Boolean(account.is_paused);
  let pauseKind = String(account.pause_kind || '');
  let overrideUntil: string | null = account.safety_override_until || null;
  let overrideWarning: string | null = account.safety_override_warning || null;
  const overrideActive = Boolean(overrideUntil && new Date(overrideUntil).getTime() > now.getTime());

  if (pauseKind === 'manual' && isPaused) {
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

  const automaticPauseStillActive = Boolean(
    pauseKind && pauseKind !== 'manual' && (pauseKind === 'permanent_bounce' || !pausedUntil || new Date(pausedUntil).getTime() > now.getTime()),
  );

  if (automaticPauseStillActive && overrideActive) {
    const patch = {
      health_stage: currentStage === 'paused' ? 'restricted' : currentStage,
      health_cap: Math.min(stageCap(currentStage === 'paused' ? 'restricted' : currentStage, totalSuccess, deploymentCap), 50),
      health_reason: `Temporary resume is active until ${new Date(overrideUntil as string).toLocaleString()}. Original warning: ${overrideWarning || pauseWarning(account)}`,
      is_paused: false,
      pause_kind: pauseKind,
      paused_until: pausedUntil,
      safety_override_until: overrideUntil,
      safety_override_warning: overrideWarning || pauseWarning(account),
      last_health_review_at: now.toISOString(),
      updated_at: now.toISOString(),
      status: 'connected',
    };
    await supabase.from('gmail_accounts').update(patch).eq('workspace_id', workspaceId).eq('id', accountId);
    return patch;
  }

  if (automaticPauseStillActive && !overrideActive) {
    const patch = {
      health_stage: currentStage === 'paused' ? 'restricted' : currentStage,
      health_cap: Math.min(stageCap(currentStage === 'paused' ? 'restricted' : currentStage, totalSuccess, deploymentCap), 50),
      health_reason: account.paused_reason || account.health_reason || 'Scout paused this sender for safety.',
      is_paused: true,
      pause_kind: pauseKind,
      paused_until: pausedUntil,
      safety_override_until: null,
      safety_override_warning: null,
      last_health_review_at: now.toISOString(),
      updated_at: now.toISOString(),
      status: pauseKind === 'provider_limit' ? 'limit_hit' : 'paused',
    };
    await supabase.from('gmail_accounts').update(patch).eq('workspace_id', workspaceId).eq('id', accountId);
    return patch;
  }

  if (pauseKind && pauseKind !== 'manual') {
    pauseKind = '';
    pausedUntil = null;
    overrideUntil = null;
    overrideWarning = null;
    isPaused = false;
    stage = 'recovering';
    reason = 'The timed safety pause ended. Scout restarted this sender in Recovering stage.';
  }

  let candidate: SenderHealthStage = stage;
  let candidateReason = reason;
  let newPauseKind = '';

  if (blockedRate > 0.10) {
    candidate = 'restricted';
    isPaused = true;
    pausedUntil = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    newPauseKind = 'message_blocked';
    candidateReason = `Message-block rate is ${(blockedRate * 100).toFixed(1)}%. Scout paused this sender for one hour.`;
  } else if (permanentRate > 0.05) {
    candidate = 'restricted';
    isPaused = true;
    pausedUntil = null;
    newPauseKind = 'permanent_bounce';
    candidateReason = `Permanent bounce rate is ${(permanentRate * 100).toFixed(1)}%. Clean the recipient list before normal sending.`;
  } else if (temporaryRate > 0.15) {
    candidate = 'recovering';
    isPaused = true;
    pausedUntil = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
    newPauseKind = 'temporary_failure';
    candidateReason = `Temporary failure rate is ${(temporaryRate * 100).toFixed(1)}%. Scout paused this sender for 30 minutes.`;
  } else if ((recentProviderLimits || 0) > 0) {
    candidate = 'restricted';
    candidateReason = 'A Gmail provider-limit event occurred during the previous 14 days.';
  } else if (spamRun >= 3) {
    candidate = 'restricted';
    candidateReason = 'Three consecutive seed tests landed in Spam. Scout reduced this sender to 50/day.';
  } else if (blockedRate >= 0.05) {
    candidate = 'restricted';
    candidateReason = `Message-block rate is ${(blockedRate * 100).toFixed(1)}%; sender reduced to the restricted stage.`;
  } else if (permanentRate >= 0.03) {
    candidate = 'restricted';
    candidateReason = `Permanent bounce rate is ${(permanentRate * 100).toFixed(1)}%; sender reduced to the restricted stage.`;
  } else if (ageDays < 2 || totalSuccess < 50) {
    candidate = 'assessment';
    candidateReason = replies24h > 0
      ? 'Sender is in checkpoint-controlled assessment and has already received a real reply.'
      : 'Sender is still in checkpoint-controlled assessment.';
  } else if (totalSuccess >= 500 && totalRealReplies === 0) {
    candidate = 'stable';
    candidateReason = 'Delivery signals are acceptable, but Scout is holding this sender at 100/day because 500 successful sends have produced no confirmed real reply yet.';
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
      ? 'Clean delivery activity and confirmed real replies support the stable stage.'
      : 'At least 100 successful sends with acceptable recent delivery results.';
  } else {
    candidate = 'recovering';
    candidateReason = 'Sender has left assessment but needs more clean sending history.';
  }

  if (!isPaused && spamRun === 2 && candidate !== 'restricted') {
    const idx = FORWARD_STAGES.indexOf(candidate);
    candidate = idx > 0 ? FORWARD_STAGES[idx - 1] : candidate;
    candidateReason = 'Two consecutive seed tests landed in Spam. Scout reduced this sender by one stage.';
  } else if (!isPaused && spamRun === 1) {
    const currentIndex = FORWARD_STAGES.indexOf(currentStage);
    const candidateIndex = FORWARD_STAGES.indexOf(candidate);
    if (candidateIndex > currentIndex && currentIndex >= 0) candidate = currentStage;
    candidateReason = 'The latest seed test landed in Spam. Scout froze automatic increases until a cleaner result appears.';
  }

  const isIncrease = FORWARD_STAGES.indexOf(candidate) > FORWARD_STAGES.indexOf(currentStage);
  const lastStageChange = account.last_stage_change_at ? new Date(account.last_stage_change_at).getTime() : 0;
  if (isIncrease) {
    if (lastStageChange && now.getTime() - lastStageChange < 24 * 60 * 60 * 1000) {
      candidate = currentStage;
      candidateReason = 'Scout allows at most one automatic stage increase in 24 hours.';
    } else {
      candidate = oneStepUp(currentStage, candidate);
    }
  }

  stage = candidate;
  reason = candidateReason;
  const stageChanged = stage !== currentStage;
  const healthCap = stageCap(stage, totalSuccess, deploymentCap);
  const patch: AnyRow = {
    health_stage: stage,
    health_cap: healthCap,
    health_reason: reason,
    is_paused: isPaused,
    pause_kind: newPauseKind || null,
    paused_until: pausedUntil,
    paused_reason: isPaused ? reason : null,
    safety_override_until: null,
    safety_override_warning: null,
    last_health_review_at: now.toISOString(),
    updated_at: now.toISOString(),
    status: isPaused ? (newPauseKind === 'provider_limit' ? 'limit_hit' : 'paused') : 'connected',
  };
  if (stageChanged) patch.last_stage_change_at = now.toISOString();

  await supabase
    .from('gmail_accounts')
    .update(patch)
    .eq('workspace_id', workspaceId)
    .eq('id', accountId);
  return patch;
}
