export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { fetchUnifiedReplyMetrics } from '@/lib/reply-metrics';
import { requireWorkspaceAccess } from '@/lib/require-workspace-access';

export async function GET(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get('workspaceId') || '';
  const startRaw = request.nextUrl.searchParams.get('start');
  const endRaw = request.nextUrl.searchParams.get('end');
  if (!workspaceId) return NextResponse.json({ success: false, error: 'workspaceId is required.' }, { status: 400 });
  try {
    await requireWorkspaceAccess(workspaceId);
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error?.message || 'Unauthorized.' }, { status: Number(error?.status || 403) });
  }
  const start = startRaw ? new Date(startRaw) : undefined;
  const end = endRaw ? new Date(endRaw) : undefined;
  const supabase = createAdminClient();
  try {
    const metrics = await fetchUnifiedReplyMetrics(supabase, workspaceId, {
      start: start && !Number.isNaN(start.getTime()) ? start : undefined,
      end: end && !Number.isNaN(end.getTime()) ? end : undefined,
      limit: 20000
    });
    return NextResponse.json({ success: true, ...metrics });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unable to load reply metrics.' }, { status: 500 });
  }
}
