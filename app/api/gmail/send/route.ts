export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { buildMimeMessage, EmailAttachment } from '@/lib/email-signature';
import { requireWorkspaceAccess } from '@/lib/require-workspace-access';
import { normalizeEmailAddress, verifyEmailBasic } from '@/lib/email-verification';
import { recordSenderHealthEvent } from '@/lib/sender-health';

function b64url(input: string) {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function looksLikeLimit(message: string, status: number) {
  const text = message.toLowerCase();
  return status === 429 || text.includes('rate limit') || text.includes('daily') || text.includes('quota') || text.includes('user-rate') || text.includes('limit exceeded');
}

function looksLikeMessageBlocked(message: string, status: number) {
  const text = message.toLowerCase();
  return status === 403 || text.includes('message blocked') || text.includes('blocked') || text.includes('policy') || text.includes('spam') || text.includes('rejected');
}

function safeFilename(value: unknown) {
  return String(value || 'attachment').replace(/[\r\n"\\]+/g, ' ').trim().slice(0, 180) || 'attachment';
}

async function prepareAttachments(items: unknown): Promise<EmailAttachment[]> {
  if (!Array.isArray(items)) return [];
  const selected = items.slice(0, 5);
  const attachments: EmailAttachment[] = [];
  let totalBytes = 0;
  for (const item of selected) {
    const row = (item || {}) as Record<string, unknown>;
    const url = String(row.public_url || row.url || '').trim();
    if (!url) continue;
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) continue;
    const response = await fetch(parsed.toString(), { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`Attachment download failed for ${safeFilename(row.name || row.filename)} with HTTP ${response.status}`);
    const contentType = String(row.mime_type || row.mimeType || response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
    const buffer = Buffer.from(await response.arrayBuffer());
    totalBytes += buffer.length;
    if (buffer.length > 10 * 1024 * 1024) throw new Error(`${safeFilename(row.name || row.filename)} is over 10 MB.`);
    if (totalBytes > 18 * 1024 * 1024) throw new Error('Attachments are too large together. Keep total attachments under about 18 MB.');
    attachments.push({
      filename: safeFilename(row.filename || row.name || parsed.pathname.split('/').pop() || 'attachment'),
      mimeType: contentType,
      contentBase64: buffer.toString('base64'),
      sizeBytes: buffer.length,
    });
  }
  return attachments;
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

async function sendWithGmail(accessToken: string, from: string, to: string, subject: string, body: string, identity?: Record<string, unknown>, attachments?: EmailAttachment[]) {
  const message = buildMimeMessage({ from, to, subject, body, identity, attachments });
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: b64url(message.raw) })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = json?.error?.message || json?.error || `Gmail send failed with HTTP ${response.status}`;
    const err = new Error(msg) as Error & { status?: number; payload?: unknown; limitHit?: boolean; blocked?: boolean };
    err.status = response.status;
    err.payload = json;
    err.limitHit = looksLikeLimit(msg, response.status);
    err.blocked = looksLikeMessageBlocked(msg, response.status);
    throw err;
  }
  return json as { id?: string; threadId?: string; labelIds?: string[] };
}

async function getBasicVerification(supabase: ReturnType<typeof createAdminClient>, workspaceId: string, email: string) {
  const { data: cached } = await supabase
    .from('email_verifications')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('email', email)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (cached) return { status: String(cached.status), reason: String(cached.reason || ''), cached: true };
  const result = await verifyEmailBasic(email);
  await supabase.from('email_verifications').upsert({
    workspace_id: workspaceId,
    email: result.email,
    domain: result.domain,
    status: result.status,
    verification_level: result.level,
    syntax_valid: result.syntaxValid,
    domain_has_mx: result.domainHasMx,
    mx_hosts: result.mxHosts,
    role_inbox: result.roleInbox,
    role_label: result.roleLabel,
    disposable: result.disposable,
    reason: result.reason,
    checked_at: result.checkedAt,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    raw: {},
  }, { onConflict: 'workspace_id,email' });
  return { status: result.status, reason: result.reason, cached: false };
}

async function waitForDispatchSlot(value: unknown) {
  const dispatchAt = new Date(String(value || '')).getTime();
  if (!Number.isFinite(dispatchAt)) return;
  const waitMs = Math.max(0, dispatchAt - Date.now());
  if (waitMs > 50_000) throw new Error('The reserved dispatch slot is too far in the future. Scout will retry automatically.');
  if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
}

export async function POST(request: NextRequest) {
  let reservationId = '';
  let workspaceId = '';
  let accountId = '';
  let to = '';
  try {
    const input = await request.json();
    workspaceId = String(input.workspace_id || '');
    accountId = String(input.gmail_account_id || '');
    to = normalizeEmailAddress(input.to || input.email);
    const subject = String(input.subject || '').trim();
    const body = String(input.body || input.message || '').trim();
    const dryRun = Boolean(input.dryRun || input.dry_run);
    if (!workspaceId || !accountId) throw new Error('workspace_id and gmail_account_id are required.');
    await requireWorkspaceAccess(workspaceId);
    if (!to || !subject || !body) throw new Error('to, subject, and body are required.');

    const supabase = createAdminClient();
    const verification = await getBasicVerification(supabase, workspaceId, to);
    if (verification.status === 'invalid') {
      await supabase.from('businesses').update({
        email_verification_status: 'invalid',
        email_verification_level: 'basic',
        email_verified_at: new Date().toISOString(),
        email_verification_reason: verification.reason,
        status: 'invalid',
        updated_at: new Date().toISOString(),
      }).eq('workspace_id', workspaceId).eq('email', to);
      return NextResponse.json({ success: false, code: 'invalid_recipient', error: verification.reason, verification }, { status: 422 });
    }

    const { data: account, error: accountError } = await supabase.from('gmail_accounts').select('*').eq('workspace_id', workspaceId).eq('id', accountId).single();
    if (accountError || !account) throw new Error(accountError?.message || 'Gmail sender account not found.');
    if (account.status && !['connected', 'ready'].includes(String(account.status))) throw new Error(`Sender is not connected. Current status: ${account.status}`);
    if (!account.refresh_token && !account.access_token) throw new Error('Sender has no Gmail OAuth token. Reconnect Gmail in Settings.');

    const attachments = await prepareAttachments(input.attachments);
    if (dryRun) {
      return NextResponse.json({ success: true, verification, results: [{ status: 'dry_run', gmailMessageId: '', gmailThreadId: '', reason: attachments.length ? `Dry run only · ${attachments.length} attachment(s) ready` : 'Dry run only' }] });
    }

    const { data: reservations, error: reservationError } = await supabase.rpc('reserve_sender_send', {
      target_workspace: workspaceId,
      target_account: accountId,
      reservation_raw: { source: 'gmail_send_route', recipient: to },
    });
    if (reservationError) throw reservationError;
    const reservation = Array.isArray(reservations) ? reservations[0] : reservations;
    if (!reservation?.allowed || !reservation?.reservation_id) {
      return NextResponse.json({
        success: false,
        code: 'sender_safety_limit',
        error: reservation?.reason || 'Sender is not currently eligible to send.',
        safety: reservation || null,
      }, { status: 429 });
    }
    reservationId = String(reservation.reservation_id);

    let accessToken = String(account.access_token || '');
    const expiresAt = account.expires_at ? new Date(account.expires_at).getTime() : 0;
    if (!accessToken || expiresAt < Date.now() + 60_000) {
      if (!account.refresh_token) throw new Error('Access token expired and no refresh token is stored. Reconnect Gmail.');
      const refreshed = await refreshAccessToken(String(account.refresh_token));
      accessToken = refreshed.access_token;
      await supabase.from('gmail_accounts').update({ access_token: accessToken, expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(), last_error: null }).eq('workspace_id', workspaceId).eq('id', accountId);
    }

    try {
      await waitForDispatchSlot(reservation.dispatch_at);
      let result;
      try {
        result = await sendWithGmail(accessToken, String(account.email), to, subject, body, account, attachments);
      } catch (sendError) {
        const err = sendError as Error & { status?: number };
        if (err.status !== 401 || !account.refresh_token) throw sendError;
        const refreshed = await refreshAccessToken(String(account.refresh_token));
        accessToken = refreshed.access_token;
        await supabase.from('gmail_accounts').update({ access_token: accessToken, expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(), last_error: null }).eq('workspace_id', workspaceId).eq('id', accountId);
        result = await sendWithGmail(accessToken, String(account.email), to, subject, body, account, attachments);
      }

      await supabase.rpc('finalize_sender_send', {
        target_reservation: reservationId,
        target_recipient: to,
        event_raw: { source: 'gmail_send_route', gmail_message_id: result.id || '', gmail_thread_id: result.threadId || '' },
      });
      reservationId = '';
      return NextResponse.json({
        success: true,
        access_token: accessToken,
        verification,
        safety: reservation,
        results: [{ status: 'sent', gmailMessageId: result.id || '', gmailThreadId: result.threadId || '', raw: result }],
      });
    } catch (sendErr) {
      const err = sendErr as Error & { status?: number; payload?: unknown; limitHit?: boolean; blocked?: boolean };
      if (reservationId) await supabase.rpc('release_sender_send', { target_reservation: reservationId, release_reason: err.message, event_raw: { source: 'gmail_send_route' } });
      reservationId = '';
      if (err.limitHit) {
        await recordSenderHealthEvent(supabase as any, { workspaceId, gmailAccountId: accountId, eventType: 'provider_limit', reason: err.message, recipient: to, raw: { status: err.status, payload: err.payload } });
        return NextResponse.json({ success: false, error: err.message, results: [{ status: 'limit_hit', reason: err.message }] }, { status: 429 });
      }
      if (err.blocked) {
        await recordSenderHealthEvent(supabase as any, { workspaceId, gmailAccountId: accountId, eventType: 'message_blocked', reason: err.message, recipient: to, raw: { status: err.status, payload: err.payload } });
        return NextResponse.json({ success: false, error: err.message, code: 'message_blocked', results: [{ status: 'message_blocked', reason: err.message }] }, { status: err.status || 403 });
      }
      await recordSenderHealthEvent(supabase as any, { workspaceId, gmailAccountId: accountId, eventType: 'temporary_failure', reason: err.message, recipient: to, raw: { status: err.status } });
      throw err;
    }
  } catch (err) {
    if (reservationId && workspaceId) {
      try {
        const supabase = createAdminClient();
        await supabase.rpc('release_sender_send', { target_reservation: reservationId, release_reason: formatError(err), event_raw: { source: 'gmail_send_route_outer' } });
      } catch {}
    }
    const status = Number((err as any)?.status || 400);
    return NextResponse.json({ success: false, error: formatError(err), results: [{ status: 'failed', reason: formatError(err) }] }, { status });
  }
}
