export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { isCronAuthorized } from '@/lib/cron-auth';
import { syncGmailInbound } from '@/lib/gmail-inbound-sync';
import { recordSenderHealthEvent } from '@/lib/sender-health';

type AnyRow = Record<string, any>;

async function repeatEvents(
  supabase: ReturnType<typeof createAdminClient>,
  account: AnyRow,
  eventType: 'permanent_bounce' | 'message_blocked' | 'provider_limit' | 'real_reply',
  count: number,
) {
  for (let index = 0; index < Math.min(20, Math.max(0, count)); index += 1) {
    await recordSenderHealthEvent(supabase as any, {
      workspaceId: String(account.workspace_id),
      gmailAccountId: String(account.id),
      eventType,
      reason: `Detected during background Gmail inbound sync (${eventType}).`,
      raw: { source: 'cron_inbound_sync' },
    });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  if (!isCronAuthorized(request, body)) return NextResponse.json({ success: false, error: 'Invalid cron secret.' }, { status: 401 });
  try {
    const supabase = createAdminClient();
    const accountLimit = Math.max(1, Math.min(3, Number(body.accountLimit || 3)));
    const { data: accounts, error } = await supabase
      .from('gmail_accounts')
      .select('*')
      .in('status', ['connected', 'ready', 'recovering'])
      .not('refresh_token', 'is', null)
      .order('updated_at', { ascending: true, nullsFirst: true })
      .limit(accountLimit);
    if (error) throw error;

    const results = await Promise.all((accounts || []).map(async (account) => {
      try {
        const replies = await syncGmailInbound({
          supabase,
          workspaceId: String(account.workspace_id),
          accountId: String(account.id),
          maxResults: Math.max(1, Math.min(5, Number(body.maxResults || 5))),
          days: Math.max(1, Math.min(14, Number(body.days || 7))),
          mode: 'replies',
          newOnly: true,
          deadlineMs: 18000,
        });
        const bounces = await syncGmailInbound({
          supabase,
          workspaceId: String(account.workspace_id),
          accountId: String(account.id),
          maxResults: Math.max(1, Math.min(5, Number(body.bounceMaxResults || 5))),
          days: Math.max(1, Math.min(14, Number(body.days || 7))),
          mode: 'bounces',
          newOnly: true,
          deadlineMs: 18000,
        });
        await repeatEvents(supabase, account, 'real_reply', Number(replies.realReplies || 0));
        await repeatEvents(supabase, account, 'permanent_bounce', Number(bounces.bounced || bounces.noInbox || 0));
        await repeatEvents(supabase, account, 'message_blocked', Number(bounces.blocked || 0));
        await repeatEvents(supabase, account, 'provider_limit', Number(bounces.limitNotices || 0));
        await supabase.from('gmail_accounts').update({ updated_at: new Date().toISOString() }).eq('id', account.id);
        return { accountId: account.id, email: account.email, success: true, replies, bounces };
      } catch (error) {
        return { accountId: account.id, email: account.email, success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }));

    return NextResponse.json({ success: true, checked: results.length, results });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
