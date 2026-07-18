export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { requireWorkspaceAccess } from '@/lib/require-workspace-access';
import { createAdminClient } from '@/lib/supabase-admin';
import { buildMimeMessage, appendSignatureToText } from '@/lib/email-signature';

function b64url(input: string) {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function normalizeEmail(value: unknown) {
  const raw = String(value || '').toLowerCase().replace(/<([^>]+)>/g, ' $1 ');
  const match = raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match?.[0] || '';
}

function looksLikeLimit(message: string, status: number) {
  const text = message.toLowerCase();
  return status === 429 || text.includes('rate limit') || text.includes('daily') || text.includes('quota') || text.includes('user-rate') || text.includes('limit exceeded');
}

function looksLikeMessageBlocked(message: string, status: number) {
  const text = message.toLowerCase();
  return status === 403 || text.includes('message blocked') || text.includes('blocked') || text.includes('policy') || text.includes('spam') || text.includes('rejected');
}

async function refreshAccessToken(refreshToken: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID/NEXT_PUBLIC_GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in Vercel.');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error_description || json?.error || `Token refresh failed with HTTP ${response.status}`);
  return { access_token: String(json.access_token || ''), expires_in: Number(json.expires_in || 3600) };
}

async function sendReplyWithGmail(accessToken: string, from: string, to: string, subject: string, body: string, threadId?: string | null, identity?: Record<string, unknown>) {
  const normalizedSubject = subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`;
  const message = buildMimeMessage({ from, to, subject: normalizedSubject, body, identity });
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: b64url(message.raw), ...(threadId ? { threadId } : {}) })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = json?.error?.message || json?.error || `Gmail reply failed with HTTP ${response.status}`;
    const err = new Error(msg) as Error & { status?: number; payload?: unknown; limitHit?: boolean; blocked?: boolean };
    err.status = response.status;
    err.payload = json;
    err.limitHit = looksLikeLimit(msg, response.status);
    err.blocked = looksLikeMessageBlocked(msg, response.status);
    throw err;
  }
  return json as { id?: string; threadId?: string; labelIds?: string[] };
}

export async function POST(request: NextRequest) {
  try {
    const input = await request.json();
    const workspaceId = String(input.workspace_id || '');
    const businessId = String(input.business_id || '');
    const requestedAccountId = String(input.gmail_account_id || '');
    const templateId = String(input.template_id || input.templateId || '').trim() || null;
    const to = normalizeEmail(input.to || input.email || '');
    const subject = String(input.subject || '').trim();
    const body = String(input.body || input.message || '').trim();
    const inputThreadId = String(input.gmail_thread_id || input.thread_id || '').trim() || null;
    if (!workspaceId || !businessId) throw new Error('workspace_id and business_id are required.');
    await requireWorkspaceAccess(workspaceId);
    if (!to || !subject || !body) throw new Error('to, subject, and body are required.');

    const supabase = createAdminClient();
    const { data: latestSent, error: latestSentError } = await supabase
      .from('sent_messages')
      .select('id,gmail_account_id,gmail_thread_id,subject,to_email,from_email,sent_at')
      .eq('workspace_id', workspaceId)
      .eq('business_id', businessId)
      .not('gmail_account_id', 'is', null)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestSentError) throw latestSentError;
    if (!latestSent?.gmail_account_id) throw new Error('Scout could not find the Gmail account that sent the original message to this business. Reply from the business page after syncing the conversation again.');
    if (requestedAccountId && requestedAccountId !== latestSent.gmail_account_id) throw new Error('For safety, Scout replies to this business only with the same Gmail account that sent the original message.');
    const accountId = String(latestSent.gmail_account_id);
    const threadId = inputThreadId || String(latestSent.gmail_thread_id || '') || null;

    const [{ data: account, error: accountError }, { data: business, error: businessError }] = await Promise.all([
      supabase.from('gmail_accounts').select('*').eq('workspace_id', workspaceId).eq('id', accountId).single(),
      supabase.from('businesses').select('id,email,name,status').eq('workspace_id', workspaceId).eq('id', businessId).single()
    ]);
    if (accountError || !account) throw new Error(accountError?.message || 'Gmail account not found.');
    if (businessError || !business) throw new Error(businessError?.message || 'Business not found.');
    if (account.status && !['connected', 'ready'].includes(String(account.status))) throw new Error(`Sender is not connected. Current status: ${account.status}`);

    let accessToken = String(account.access_token || '');
    const expiresAt = account.expires_at ? new Date(account.expires_at).getTime() : 0;
    if (!accessToken || expiresAt < Date.now() + 60_000) {
      if (!account.refresh_token) throw new Error('Access token expired and no refresh token is stored. Reconnect Gmail.');
      const refreshed = await refreshAccessToken(String(account.refresh_token));
      accessToken = refreshed.access_token;
      await supabase.from('gmail_accounts').update({ access_token: accessToken, expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq('workspace_id', workspaceId).eq('id', accountId);
    }

    try {
      const result = await sendReplyWithGmail(accessToken, String(account.email), to, subject, body, threadId, account);
      const sentAt = new Date().toISOString();
      await supabase.from('sent_messages').insert({
        workspace_id: workspaceId,
        business_id: businessId,
        gmail_account_id: accountId,
        template_id: templateId,
        to_email: to,
        from_email: String(account.email),
        subject: subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`,
        body: appendSignatureToText(body, account),
        provider_message_id: result.id || null,
        gmail_thread_id: result.threadId || threadId,
        status: 'sent',
        delivery_status: 'manual_reply_sent',
        is_follow_up: true,
        sent_at: sentAt,
        raw: { source: 'business_manual_reply', reply_template_id: templateId, gmail: result }
      });
      await supabase.from('businesses').update({ last_manual_reply_at: sentAt, updated_at: sentAt }).eq('workspace_id', workspaceId).eq('id', businessId);
      return NextResponse.json({ success: true, gmailMessageId: result.id || '', gmailThreadId: result.threadId || threadId || '' });
    } catch (sendErr) {
      const err = sendErr as Error & { status?: number; payload?: unknown; limitHit?: boolean; blocked?: boolean };
      if (err.limitHit) {
        const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await supabase.from('gmail_accounts').update({ status: 'limit_hit', paused_until: until, last_error: err.message, updated_at: new Date().toISOString() }).eq('workspace_id', workspaceId).eq('id', accountId);
        return NextResponse.json({ success: false, code: 'limit_hit', error: err.message, senderPausedUntil: until }, { status: 429 });
      }
      if (err.blocked) {
        await supabase.from('gmail_accounts').update({ last_error: err.message, updated_at: new Date().toISOString() }).eq('workspace_id', workspaceId).eq('id', accountId);
        return NextResponse.json({ success: false, code: 'message_blocked', error: err.message }, { status: err.status || 403 });
      }
      throw err;
    }
  } catch (err) {
    return NextResponse.json({ success: false, error: formatError(err) }, { status: 400 });
  }
}
