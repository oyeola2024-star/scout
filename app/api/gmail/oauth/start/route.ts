export const runtime = 'nodejs';

import { createHmac } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireWorkspaceAccess } from '@/lib/require-workspace-access';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.settings.basic'
];

function encodeState(payload: Record<string, unknown>, secret: string) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function safeReturnPath(value: string) {
  return value.startsWith('/') && !value.startsWith('//') ? value : '/settings';
}

export async function GET(request: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const origin = request.nextUrl.origin;
  const workspaceId = request.nextUrl.searchParams.get('workspace_id') || '';
  const returnTo = safeReturnPath(request.nextUrl.searchParams.get('return') || '/settings');

  if (!workspaceId) return NextResponse.redirect(new URL('/settings?gmail_error=missing_workspace', origin));
  try {
    await requireWorkspaceAccess(workspaceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.redirect(new URL(`/settings?gmail_error=${encodeURIComponent(message)}`, origin));
  }
  if (!clientId || !clientSecret) return NextResponse.redirect(new URL('/settings?gmail_error=google_oauth_env_missing', origin));

  const redirectUri = `${origin}/api/gmail/oauth/callback`;
  const state = encodeState({ workspace_id: workspaceId, return_to: returnTo, created_at: Date.now() }, clientSecret);
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id', clientId);
  auth.searchParams.set('redirect_uri', redirectUri);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', SCOPES.join(' '));
  auth.searchParams.set('access_type', 'offline');
  auth.searchParams.set('prompt', 'consent select_account');
  auth.searchParams.set('include_granted_scopes', 'false');
  auth.searchParams.set('state', state);
  return NextResponse.redirect(auth);
}
