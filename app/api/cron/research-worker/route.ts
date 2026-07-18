export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { isCronAuthorized } from '@/lib/cron-auth';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  if (!isCronAuthorized(request, body)) {
    return NextResponse.json({ success: false, error: 'Invalid cron secret.' }, { status: 401 });
  }

  try {
    const supabase = createAdminClient();
    const workspaceLimit = Math.max(1, Math.min(1, Number(body.workspaceLimit || 1)));
    const { data: queued, error } = await supabase
      .from('email_research_jobs')
      .select('workspace_id,updated_at')
      .eq('status', 'queued')
      .order('updated_at', { ascending: true })
      .limit(100);
    if (error) throw error;

    const workspaceIds = Array.from(new Set((queued || []).map((row: any) => String(row.workspace_id || '')).filter(Boolean))).slice(0, workspaceLimit);
    const secret = process.env.CRON_SECRET || process.env.SCHEDULE_WORKER_SECRET || '';
    const results: Array<Record<string, unknown>> = [];

    for (const workspaceId of workspaceIds) {
      try {
        const response = await fetch(new URL('/api/research/run-worker', request.nextUrl.origin), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-cron-secret': secret,
          },
          body: JSON.stringify({
            workspaceId,
            autoEnqueue: false,
            cycles: 1,
            batchSize: 2,
            concurrency: 2,
            token: secret,
          }),
          cache: 'no-store',
        });
        const json: any = await response.json().catch(() => ({}));
        results.push({ workspaceId, success: response.ok && json?.success !== false, ...json });
      } catch (error) {
        results.push({ workspaceId, success: false, error: errorMessage(error) });
      }
    }

    return NextResponse.json({ success: true, workspacesChecked: workspaceIds.length, results });
  } catch (error) {
    return NextResponse.json({ success: false, error: errorMessage(error) }, { status: 500 });
  }
}
