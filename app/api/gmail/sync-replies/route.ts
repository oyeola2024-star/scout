export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { requireWorkspaceAccess } from '@/lib/require-workspace-access';
import { createAdminClient } from '@/lib/supabase-admin';
import { formatInboundError, syncGmailInbound } from '@/lib/gmail-inbound-sync';

export async function POST(request: NextRequest) {
  try {
    const input = await request.json().catch(() => ({}));
    const workspaceId = String(input.workspace_id || input.workspaceId || '');
    const accountId = String(input.gmail_account_id || input.accountId || '');
    await requireWorkspaceAccess(workspaceId);
    const maxResults = Number(input.max_results || input.limit || 100);
    const days = Number(input.days || 30);
    const supabase = createAdminClient();
    const result = await syncGmailInbound({ supabase, workspaceId, accountId, maxResults, days, mode: 'replies' });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ success: false, error: formatInboundError(err) }, { status: 400 });
  }
}
