export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { requireWorkspaceAccess } from '@/lib/require-workspace-access';
import { createAdminClient } from '@/lib/supabase-admin';
import { signatureHtml, signatureText } from '@/lib/email-signature';

type AnyRow = Record<string, any>;

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

async function refreshAccessToken(account: AnyRow) {
  const clientId = process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID/NEXT_PUBLIC_GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in Vercel.');
  if (!account.refresh_token) throw new Error(`No refresh token for ${account.email}. Reconnect Gmail in Settings.`);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    signal: AbortSignal.timeout(12000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: String(account.refresh_token), grant_type: 'refresh_token' })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error_description || json?.error || `Token refresh failed with HTTP ${response.status}`);
  return { access_token: String(json.access_token || ''), expires_in: Number(json.expires_in || 3600) };
}

async function ensureAccessToken(supabase: ReturnType<typeof createAdminClient>, account: AnyRow) {
  let accessToken = String(account.access_token || '');
  const expiresAt = account.expires_at ? new Date(account.expires_at).getTime() : 0;
  if (!accessToken || expiresAt < Date.now() + 60_000) {
    const refreshed = await refreshAccessToken(account);
    accessToken = refreshed.access_token;
    await supabase.from('gmail_accounts').update({
      access_token: accessToken,
      expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
      last_error: null
    }).eq('workspace_id', account.workspace_id).eq('id', account.id);
    account.access_token = accessToken;
    account.expires_at = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  }
  return accessToken;
}

async function syncSignatureToGmail(accessToken: string, email: string, html: string) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs/${encodeURIComponent(email)}`, {
    method: 'PATCH',
    signal: AbortSignal.timeout(12000),
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ signature: html })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = json?.error?.message || json?.error || `Gmail signature sync failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return json;
}

export async function POST(request: NextRequest) {
  try {
    const input = await request.json().catch(() => ({}));
    const workspaceId = String(input.workspace_id || '').trim();
    const accountId = String(input.gmail_account_id || '').trim();
    const applyAll = Boolean(input.apply_all || input.applyAll);
    const syncToGmail = Boolean(input.sync_to_gmail || input.syncToGmail);
    const signature_enabled = input.signature_enabled !== false;
    const signature_html = String(input.signature_html || '').trim();
    const signature_text = String(input.signature_text || '').trim();
    const signature_logo_url = String(input.signature_logo_url || input.logo_url || '').trim();
    if (!workspaceId) throw new Error('workspace_id is required.');
    await requireWorkspaceAccess(workspaceId);
    if (!applyAll && !accountId) throw new Error('gmail_account_id is required unless apply_all is true.');

    const supabase = createAdminClient();

    const identity = { signature_enabled, signature_html, signature_text, signature_logo_url };
    const safeHtml = signatureHtml(identity);
    const safeText = signatureText(identity);

    const workspaceUpdate: Record<string, unknown> = {
      email_signature_text: safeText,
      email_signature_html: safeHtml,
      email_logo_url: signature_logo_url || null,
      updated_at: new Date().toISOString()
    };
    const { error: workspaceError } = await supabase
      .from('workspaces')
      .update(workspaceUpdate)
      .eq('id', workspaceId);
    if (workspaceError) {
      const msg = formatError(workspaceError).toLowerCase();
      const missingWorkspaceColumns = msg.includes('email_signature') || msg.includes('email_logo_url');
      if (!missingWorkspaceColumns) throw workspaceError;
    }

    let query = supabase.from('gmail_accounts').select('*').eq('workspace_id', workspaceId);
    if (!applyAll) query = query.eq('id', accountId);
    const { data: accounts, error: accountError } = await query.order('created_at', { ascending: true });
    if (accountError) throw accountError;
    const rows = accounts || [];
    if (!rows.length) {
      return NextResponse.json({
        success: true,
        updated: 0,
        workspace_saved: true,
        results: [],
        message: syncToGmail
          ? 'Signature and logo were saved to the workspace, but no Gmail sender accounts are connected yet. Connect Gmail before syncing to Gmail.'
          : 'Signature and logo were saved to the workspace.'
      });
    }

    const results: Array<Record<string, unknown>> = [];

    for (const account of rows) {
      const baseUpdate: Record<string, unknown> = {
        signature_enabled,
        signature_html: safeHtml,
        signature_text: safeText,
        signature_logo_url,
        sync_signature_to_gmail: syncToGmail,
        gmail_signature_sync_error: null,
        updated_at: new Date().toISOString(),
        raw: { ...(account.raw || {}), email_identity: { ...((account.raw || {}).email_identity || {}), signature_enabled, signature_html: safeHtml, signature_text: safeText, signature_logo_url }, email_identity_updated_at: new Date().toISOString() }
      };

      let syncStatus = syncToGmail ? 'pending' : 'not_requested';
      let syncError = '';
      if (syncToGmail) {
        try {
          const accessToken = await ensureAccessToken(supabase, account);
          await syncSignatureToGmail(accessToken, String(account.email), safeHtml);
          syncStatus = 'synced';
          baseUpdate.gmail_signature_synced_at = new Date().toISOString();
        } catch (err) {
          syncStatus = 'failed';
          syncError = formatError(err);
          baseUpdate.gmail_signature_sync_error = syncError;
        }
      }

      const { error: updateError } = await supabase
        .from('gmail_accounts')
        .update(baseUpdate)
        .eq('workspace_id', workspaceId)
        .eq('id', account.id);
      if (updateError) {
        const msg = formatError(updateError).toLowerCase();
        const missingSignatureColumn = msg.includes('signature_') || msg.includes('gmail_signature_') || msg.includes('sync_signature_to_gmail');
        if (!missingSignatureColumn) throw updateError;
        const fallbackRaw = {
          ...(account.raw || {}),
          email_identity: { signature_enabled, signature_html: safeHtml, signature_text: safeText, signature_logo_url, sync_signature_to_gmail: syncToGmail },
          email_identity_updated_at: new Date().toISOString(),
          email_identity_note: 'Saved in raw fallback because signature columns were missing. Run the v8.41 Supabase repair SQL.'
        };
        const { error: fallbackError } = await supabase
          .from('gmail_accounts')
          .update({ raw: fallbackRaw, updated_at: new Date().toISOString() })
          .eq('workspace_id', workspaceId)
          .eq('id', account.id);
        if (fallbackError) throw fallbackError;
      }
      results.push({ account_id: account.id, email: account.email, sync_status: syncStatus, sync_error: syncError });
    }

    return NextResponse.json({ success: true, updated: results.length, workspace_saved: true, results });
  } catch (error) {
    return NextResponse.json({ success: false, error: formatError(error) }, { status: 400 });
  }
}
