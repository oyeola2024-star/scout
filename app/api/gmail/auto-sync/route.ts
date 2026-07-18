export const runtime = 'nodejs';
export const maxDuration = 15;

import { NextRequest, NextResponse } from 'next/server';
import { requireWorkspaceAccess } from '@/lib/require-workspace-access';
import { createAdminClient } from '@/lib/supabase-admin';
import { formatInboundError, syncGmailInbound } from '@/lib/gmail-inbound-sync';

type AnyRecord = Record<string, any>;

type AccountResult = {
  accountId: string;
  email: string;
  scanned: number;
  saved: number;
  realReplies: number;
  autoReplies: number;
  noInbox: number;
  blocked: number;
  bounced: number;
  limitNotices: number;
  skippedOld: number;
  error?: string;
};

function num(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function addStats(row: AccountResult, stats: AnyRecord) {
  row.scanned += Number(stats.scanned || 0);
  row.saved += Number(stats.saved || 0);
  row.realReplies += Number(stats.realReplies || 0);
  row.autoReplies += Number(stats.autoReplies || 0);
  row.noInbox += Number(stats.noInbox || 0);
  row.blocked += Number(stats.blocked || 0);
  row.bounced += Number(stats.bounced || 0);
  row.limitNotices += Number(stats.limitNotices || 0);
  row.skippedOld += Number(stats.ignored || 0);
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const input = await request.json().catch(() => ({}));
    const workspaceId = String(input.workspace_id || input.workspaceId || '');
    if (!workspaceId) throw new Error('workspaceId is required.');
    await requireWorkspaceAccess(workspaceId);

    // App-open sync must be tiny and new-only. Full sync stays on Replies page.
    const maxResults = Math.max(1, Math.min(num(input.max_results || input.maxResults, 3), 5));
    const bounceMaxResults = Math.max(0, Math.min(num(input.bounce_max_results || input.bounceMaxResults, 0), 2));
    const days = Math.max(1, Math.min(num(input.days, 2), 3));
    const accountLimit = Math.max(1, Math.min(num(input.account_limit || input.accountLimit, 2), 3));
    const deadlineMs = Math.max(3500, Math.min(num(input.deadlineMs || input.deadline_ms, 8000), 10000));

    const supabase = createAdminClient();
    const { data: accounts, error: accountsError } = await supabase
      .from('gmail_accounts')
      .select('*')
      .eq('workspace_id', workspaceId)
      .in('status', ['connected', 'ready'])
      .order('updated_at', { ascending: true, nullsFirst: true })
      .limit(accountLimit);

    if (accountsError) throw accountsError;

    const results: AccountResult[] = [];
    const rows = Array.isArray(accounts) ? (accounts as AnyRecord[]) : [];

    for (const account of rows) {
      if (Date.now() - startedAt > deadlineMs) break;
      const accountId = String(account.id || '');
      const email = String(account.email || 'Gmail account');
      if (!accountId) continue;

      const row: AccountResult = {
        accountId,
        email,
        scanned: 0,
        saved: 0,
        realReplies: 0,
        autoReplies: 0,
        noInbox: 0,
        blocked: 0,
        bounced: 0,
        limitNotices: 0,
        skippedOld: 0
      };

      try {
        const replies = await syncGmailInbound({
          supabase,
          workspaceId,
          accountId,
          maxResults,
          days,
          mode: 'replies',
          newOnly: true,
          deadlineMs: Math.max(2500, deadlineMs - (Date.now() - startedAt))
        });
        addStats(row, replies);

        if (bounceMaxResults > 0 && Date.now() - startedAt < deadlineMs - 2500) {
          const bounces = await syncGmailInbound({
            supabase,
            workspaceId,
            accountId,
            maxResults: bounceMaxResults,
            days,
            mode: 'bounces',
            newOnly: true,
            deadlineMs: Math.max(2000, deadlineMs - (Date.now() - startedAt))
          });
          addStats(row, bounces);
        }
      } catch (err) {
        row.error = formatInboundError(err);
        // Do not create a bell notification for quick-check failures. A full manual sync can be run from Replies.
      }

      results.push(row);
    }

    const totals = results.reduce((acc, row) => {
      acc.scanned += row.scanned;
      acc.saved += row.saved;
      acc.realReplies += row.realReplies;
      acc.autoReplies += row.autoReplies;
      acc.noInbox += row.noInbox;
      acc.blocked += row.blocked;
      acc.bounced += row.bounced;
      acc.limitNotices += row.limitNotices;
      acc.skippedOld += row.skippedOld;
      if (row.error) acc.errors += 1;
      return acc;
    }, { scanned: 0, saved: 0, realReplies: 0, autoReplies: 0, noInbox: 0, blocked: 0, bounced: 0, limitNotices: 0, skippedOld: 0, errors: 0 });

    return NextResponse.json({
      success: true,
      source: 'app_open_tiny_new_reply_pulse',
      newOnly: true,
      accountsChecked: results.length,
      totals,
      results,
      durationMs: Date.now() - startedAt
    });
  } catch (err) {
    const message = formatInboundError(err);
    // v10.27: if Supabase is temporarily out of connections, do not make app load feel broken.
    // The next tiny pulse or manual full sync can retry.
    const poolTimeout = message.includes('PGRST003') || /connection pool/i.test(message);
    return NextResponse.json({ success: !poolTimeout, skipped: poolTimeout, retryLater: poolTimeout, error: message }, { status: poolTimeout ? 200 : 400 });
  }
}
