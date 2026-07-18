export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAppNotification } from '@/lib/notifications';

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return NextResponse.json({ success: false, error: userError?.message || 'Not signed in.' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const workspaceId = String(body.workspaceId || body.workspace_id || '').trim();
    const scheduleId = String(body.scheduleId || body.schedule_id || '').trim();
    if (!workspaceId || !scheduleId) return NextResponse.json({ success: false, error: 'Missing workspaceId or scheduleId.' }, { status: 400 });

    const { data: member, error: memberError } = await supabase
      .from('workspace_members')
      .select('workspace_id,user_id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .limit(1);
    if (memberError) throw memberError;
    if (!member?.length) return NextResponse.json({ success: false, error: 'You do not belong to this workspace.' }, { status: 403 });

    const { data: existing, error: existingError } = await supabase
      .from('message_schedules')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('id', scheduleId)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) return NextResponse.json({ success: false, error: 'No sending job was found.' }, { status: 404 });

    const status = String(existing.status || '');
    if (['sent', 'complete', 'completed', 'cancelled'].includes(status)) {
      return NextResponse.json({ success: false, error: 'This sending job is already finished.' }, { status: 409 });
    }

    const heartbeatMs = existing.last_heartbeat_at ? new Date(existing.last_heartbeat_at).getTime() : 0;
    const runningNow = status === 'running' && heartbeatMs > 0 && Date.now() - heartbeatMs < 2 * 60 * 1000;
    if (runningNow && !existing.stop_requested) {
      return NextResponse.json({ success: true, alreadyRunning: true, schedule: existing });
    }

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('message_schedules')
      .update({
        status: 'scheduled',
        stop_requested: false,
        stopped_at: null,
        finished_at: null,
        scheduled_for: now,
        last_error: null,
        updated_at: now,
      })
      .eq('workspace_id', workspaceId)
      .eq('id', scheduleId)
      .in('status', ['scheduled', 'due', 'running', 'stopped', 'failed'])
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ success: false, error: 'No unfinished sending job was found.' }, { status: 404 });

    await createAppNotification(supabase as any, {
      workspaceId,
      type: 'job_continued',
      title: 'Sending job continued',
      message: 'Scout will continue the remaining recipients in the background using automatic sender delays.',
      entityType: 'message_schedule',
      entityId: scheduleId,
      raw: { schedule_id: scheduleId },
    });

    const secret = process.env.SCHEDULE_WORKER_SECRET || process.env.CRON_SECRET || '';
    try {
      await fetch(`${request.nextUrl.origin}/api/message/run-schedules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(secret ? { 'x-schedule-worker-secret': secret } : {}) },
        body: JSON.stringify({ limit: 1, scheduleId, token: secret }),
      });
    } catch {}

    return NextResponse.json({ success: true, schedule: data });
  } catch (error) {
    return NextResponse.json({ success: false, error: formatError(error) }, { status: 500 });
  }
}
