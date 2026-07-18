export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { requireWorkspaceAccess } from '@/lib/require-workspace-access';
import { createAppNotification } from '@/lib/notifications';
import { issuePolicy, recordSenderHealthEvent } from '@/lib/sender-health';

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function hardRestrictionActive(account: Record<string, any>) {
  if (!account.hard_restriction_active) return false;
  if (!account.hard_restricted_until) return true;
  return new Date(account.hard_restricted_until).getTime() > Date.now();
}

export async function POST(request: NextRequest) {
  try {
    const input = await request.json().catch(() => ({}));
    const workspaceId = String(input.workspace_id || input.workspaceId || '').trim();
    const accountId = String(input.gmail_account_id || input.accountId || '').trim();
    const action = String(input.action || '').trim().toLowerCase();
    if (!workspaceId || !accountId) throw new Error('workspace_id and gmail_account_id are required.');
    if (!['pause', 'resume', 'temporary_resume'].includes(action)) throw new Error('Unknown sender control action.');
    await requireWorkspaceAccess(workspaceId);

    const supabase = createAdminClient();
    const { data: account, error } = await supabase
      .from('gmail_accounts')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('id', accountId)
      .single();
    if (error || !account) throw new Error(error?.message || 'Gmail account not found.');

    const automaticPause = Boolean(account.pause_kind && String(account.pause_kind) !== 'manual');
    const warning = String(account.paused_reason || account.health_reason || account.last_error || 'Scout paused this Gmail account for safety.');

    if (action === 'pause') {
      if (automaticPause && account.safety_override_active) {
        const now = new Date().toISOString();
        const { error: restoreError } = await supabase
          .from('gmail_accounts')
          .update({
            is_paused: true,
            status: account.pause_kind === 'provider_limit' ? 'limit_hit' : 'paused',
            health_stage: 'restricted',
            health_cap: 0,
            paused_reason: warning,
            health_reason: warning,
            safety_override_active: false,
            safety_override_until: null,
            safety_override_warning: null,
            updated_at: now,
          })
          .eq('workspace_id', workspaceId)
          .eq('id', accountId);
        if (restoreError) throw restoreError;
        await supabase.from('sender_health_events').insert({
          workspace_id: workspaceId,
          gmail_account_id: accountId,
          event_type: 'manual_pause',
          reason: `User ended the warned resume and restored the original safety pause: ${warning}`,
          raw: { restored_pause_kind: account.pause_kind, restored_paused_until: account.paused_until },
          created_at: now,
        });
        return NextResponse.json({ success: true, status: 'paused', restoredSafetyPause: true, warning });
      }

      await recordSenderHealthEvent(supabase as any, {
        workspaceId,
        gmailAccountId: accountId,
        eventType: 'manual_pause',
        reason: 'Paused manually by the user.',
      });
      return NextResponse.json({ success: true, status: 'paused' });
    }

    if (hardRestrictionActive(account)) {
      const until = account.hard_restricted_until || null;
      return NextResponse.json({
        success: false,
        code: 'hard_restriction_active',
        error: account.hard_restriction_reason || warning,
        hardRestrictedUntil: until,
        issueCount: Number(account.pause_issue_count || 3),
      }, { status: 423 });
    }

    if (action === 'resume') {
      if (automaticPause) {
        return NextResponse.json({
          success: false,
          code: 'warning_resume_required',
          error: warning,
          pauseKind: account.pause_kind,
          issueCount: Number(account.pause_issue_count || 1),
        }, { status: 409 });
      }
      await recordSenderHealthEvent(supabase as any, {
        workspaceId,
        gmailAccountId: accountId,
        eventType: 'manual_resume',
        reason: 'Manual pause ended by the user.',
      });
      return NextResponse.json({ success: true, status: 'connected' });
    }

    if (!automaticPause) {
      await recordSenderHealthEvent(supabase as any, {
        workspaceId,
        gmailAccountId: accountId,
        eventType: 'manual_resume',
        reason: 'Sender resumed.',
      });
      return NextResponse.json({ success: true, status: 'connected' });
    }

    await recordSenderHealthEvent(supabase as any, {
      workspaceId,
      gmailAccountId: accountId,
      eventType: 'temporary_resume',
      reason: warning,
      raw: {
        pause_kind: account.pause_kind,
        issue_count: Number(account.pause_issue_count || 1),
        original_paused_until: account.paused_until,
      },
    });

    const policy = issuePolicy(String(account.pause_kind || ''));
    const issueCount = Number(account.pause_issue_count || 1);
    const nextConsequence = issueCount >= 2
      ? `If the same issue happens again, Scout will hard-restrict this Gmail ${policy?.hardRestrictionMs === null ? 'until the recipient list is cleaned' : 'for the required safety period'}.`
      : 'If the same issue happens again, Scout will pause this Gmail and increase its issue count.';

    await createAppNotification(supabase as any, {
      workspaceId,
      type: 'sender_resume_warning',
      title: `Resumed with warning: ${account.email}`,
      message: `${warning} Scout resumed this Gmail at the Recovering limit of 50/day. ${nextConsequence}`,
      entityType: 'gmail_account',
      entityId: accountId,
      raw: {
        gmail_account_id: accountId,
        gmail_email: account.email,
        pause_kind: account.pause_kind,
        original_reason: warning,
        issue_count: issueCount,
      },
    });

    return NextResponse.json({
      success: true,
      status: 'connected',
      resumedWithWarning: true,
      warning,
      issueCount,
      currentCap: 50,
      nextConsequence,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: formatError(error) }, { status: 400 });
  }
}
