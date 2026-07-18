export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { requireWorkspaceAccess } from '@/lib/require-workspace-access';
import { createAdminClient } from '@/lib/supabase-admin';
import { recordSenderHealthEvent } from '@/lib/sender-health';

function b64url(input: string) {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

async function refreshAccessToken(refreshToken: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID/NEXT_PUBLIC_GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in Vercel.');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    signal: AbortSignal.timeout(12000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error_description || json?.error || `Token refresh failed with HTTP ${response.status}`);
  return { access_token: String(json.access_token || ''), expires_in: Number(json.expires_in || 3600) };
}

async function ensureAccessToken(supabase: ReturnType<typeof createAdminClient>, account: any) {
  let accessToken = String(account.access_token || '');
  const expiresAt = account.expires_at ? new Date(account.expires_at).getTime() : 0;
  if (!accessToken || expiresAt < Date.now() + 60_000) {
    if (!account.refresh_token) throw new Error(`${account.email} has no refresh token. Reconnect Gmail.`);
    const refreshed = await refreshAccessToken(String(account.refresh_token));
    accessToken = refreshed.access_token;
    await supabase.from('gmail_accounts').update({ access_token: accessToken, expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(), last_error: null }).eq('id', account.id);
  }
  return accessToken;
}

async function sendWithGmail(accessToken: string, from: string, to: string, subject: string, body: string) {
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: b64url([`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', '', body].join('\r\n')) })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error?.message || json?.error || `Gmail send failed with HTTP ${response.status}`);
  return json as { id?: string; threadId?: string };
}

async function gmailFetch(accessToken: string, url: string) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(12000) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error?.message || json?.error || `Gmail fetch failed with HTTP ${response.status}`);
  return json;
}

function placementFromLabels(labelIds: string[] | undefined) {
  const labels = new Set((labelIds || []).map(String));
  if (labels.has('SPAM')) return 'spam';
  if (labels.has('CATEGORY_PROMOTIONS')) return 'promotions';
  if (labels.has('INBOX')) return 'inbox';
  return 'not_found';
}

async function runSeedInboxTest(workspaceId: string) {
  if (!workspaceId) throw new Error('workspace_id is required.');

  const supabase = createAdminClient();
  const { data: accounts, error: accountError } = await supabase
    .from('gmail_accounts')
    .select('*')
    .eq('workspace_id', workspaceId)
    .in('status', ['connected', 'ready']);
  if (accountError) throw accountError;

  const readyAccounts = (accounts || []).filter((a: any) => a.access_token || a.refresh_token);
  const senders = readyAccounts.filter((a: any) => !a.paused_until || new Date(a.paused_until).getTime() <= Date.now());
  const seeds = readyAccounts.filter((a: any) => Boolean(a.seed_inbox_enabled));
  if (!senders.length) throw new Error('No connected Gmail senders found.');
  if (!seeds.length) throw new Error('No seed receiver is saved yet. Turn on Use as seed receiver for at least one connected Gmail account, then click Run seed inbox test now. v8.26 saves the checkbox automatically.');
  const possiblePairs = senders
    .flatMap((sender: any) => seeds.map((seed: any) => ({ sender, seed })))
    .filter(({ sender, seed }: any) => sender.id !== seed.id);
  const maxPairsPerRun = 6;
  const pairsToTest = possiblePairs.slice(0, maxPairsPerRun);
  if (!possiblePairs.length) throw new Error('Seed inbox testing needs at least 2 connected Gmail accounts: one sender and one seed inbox. Scout does not count sending an account to itself as a useful spam placement test.');

  let sent = 0;
  let inbox = 0;
  let spam = 0;
  let promotions = 0;
  let notFound = 0;
  const results: Array<Record<string, unknown>> = [];

  for (const { sender, seed } of pairsToTest) {
      const senderToken = await ensureAccessToken(supabase, sender);
      const seedEmail = String(seed.seed_test_address || seed.email || '').toLowerCase();
      if (!seedEmail) continue;
      const stamp = Date.now();
      const subject = `[Scout Seed Test ${stamp}] ${sender.email}`;
      let placement = 'sent_pending_check';
      let gmailMessageId = '';
      let gmailThreadId = '';
      try {
        const sentMessage = await sendWithGmail(senderToken, String(sender.email), seedEmail, subject, `Scout deliverability seed test. Sender: ${sender.email}. Seed: ${seedEmail}. Stamp: ${stamp}.`);
        gmailMessageId = sentMessage.id || '';
        gmailThreadId = sentMessage.threadId || '';
        sent += 1;
      } catch (err) {
        placement = String(formatError(err)).toLowerCase().includes('blocked') ? 'blocked' : 'bounced';
      }

      if (placement === 'sent_pending_check') {
        await new Promise((resolve) => setTimeout(resolve, 3500));
      }

      try {
        const seedToken = await ensureAccessToken(supabase, seed);
        const q = encodeURIComponent(`subject:"${subject}" newer_than:1d`);
        const list = await gmailFetch(seedToken, `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&includeSpamTrash=true&maxResults=1`);
        const found = list.messages?.[0];
        if (found?.id) {
          const msg = await gmailFetch(seedToken, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${found.id}?format=metadata`);
          placement = placementFromLabels(msg.labelIds || []);
        } else if (placement === 'sent_pending_check') {
          placement = 'not_found';
        }
      } catch {
        if (placement === 'sent_pending_check') placement = 'not_found';
      }

      if (placement === 'inbox') inbox += 1;
      else if (placement === 'spam') spam += 1;
      else if (placement === 'promotions') promotions += 1;
      else if (placement === 'not_found') notFound += 1;

      await supabase.from('seed_inbox_tests').insert({
        workspace_id: workspaceId,
        sender_gmail_account_id: sender.id,
        seed_gmail_account_id: seed.id,
        sender_email: String(sender.email).toLowerCase(),
        seed_email: seedEmail,
        subject,
        placement,
        checked_at: new Date().toISOString(),
        gmail_message_id: gmailMessageId || null,
        gmail_thread_id: gmailThreadId || null,
        raw: { source: 'v8.26_seed_test', placement, subject, checked_after_ms: 3500 }
      });

      const risk = placement === 'spam' ? 'spam_risk' : placement === 'promotions' ? 'promotion_risk' : placement === 'inbox' ? 'seed_inbox_ok' : placement;
      await supabase.from('gmail_accounts').update({ spam_risk_status: risk, last_seed_result: placement, last_seed_checked_at: new Date().toISOString() }).eq('workspace_id', workspaceId).eq('id', sender.id);
      if (placement === 'spam') {
        await recordSenderHealthEvent(supabase as any, {
          workspaceId,
          gmailAccountId: String(sender.id),
          eventType: 'seed_spam',
          reason: `Seed inbox test to ${seedEmail} landed in Spam.`,
          recipient: seedEmail,
          raw: { subject, seed_gmail_account_id: seed.id, placement },
        });
      }
      results.push({ sender: sender.email, seed: seedEmail, placement });
  }

  return {
    success: true,
    sent,
    inbox,
    spam,
    promotions,
    not_found: notFound,
    tested_pairs: results.length,
    total_available_pairs: possiblePairs.length,
    remaining_pairs: Math.max(0, possiblePairs.length - results.length),
    note: possiblePairs.length > maxPairsPerRun
      ? `Scout tested ${maxPairsPerRun} sender/seed pairs in this run to stay within the Vercel function limit. Run the test again for additional pairs.`
      : null,
    results
  };
}

export async function POST(request: NextRequest) {
  try {
    const input = await request.json().catch(() => ({}));
    const workspaceId = String(input.workspace_id || '');
    await requireWorkspaceAccess(workspaceId);
    return NextResponse.json(await runSeedInboxTest(workspaceId));
  } catch (err) {
    return NextResponse.json({ success: false, error: formatError(err) }, { status: 400 });
  }
}

