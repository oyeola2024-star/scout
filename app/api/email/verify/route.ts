export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { requireWorkspaceAccess } from '@/lib/require-workspace-access';
import { normalizeEmailAddress, verifyEmailBasic } from '@/lib/email-verification';

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function POST(request: NextRequest) {
  try {
    const input = await request.json().catch(() => ({}));
    const workspaceId = String(input.workspace_id || input.workspaceId || '').trim();
    await requireWorkspaceAccess(workspaceId);
    const emails = Array.from(new Set(
      (Array.isArray(input.emails) ? input.emails : [input.email])
        .map(normalizeEmailAddress)
        .filter(Boolean),
    )).slice(0, 100);
    if (!emails.length) return NextResponse.json({ success: false, error: 'Provide at least one email address.' }, { status: 400 });

    const supabase = createAdminClient();
    const results = [];
    for (const email of emails) {
      const { data: cached } = await supabase
        .from('email_verifications')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('email', email)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();
      if (cached) {
        results.push({
          email,
          status: cached.status,
          syntaxValid: cached.syntax_valid,
          domain: cached.domain,
          domainHasMx: cached.domain_has_mx,
          mxHosts: cached.mx_hosts || [],
          roleInbox: cached.role_inbox,
          roleLabel: cached.role_label,
          disposable: cached.disposable,
          reason: cached.reason,
          checkedAt: cached.checked_at,
          level: cached.verification_level,
          cached: true,
        });
        continue;
      }
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
      results.push({ ...result, cached: false });
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    const status = Number((error as any)?.status || 500);
    return NextResponse.json({ success: false, error: formatError(error) }, { status });
  }
}
