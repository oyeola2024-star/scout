export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

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
    const allStopped = Boolean(body.allStopped || body.all_stopped || body.all);
    if (!workspaceId) return NextResponse.json({ success: false, error: 'Missing workspaceId.' }, { status: 400 });

    const { data: member, error: memberError } = await supabase
      .from('workspace_members')
      .select('workspace_id,user_id,approved')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .limit(1);
    if (memberError) throw memberError;
    if (!member?.length) return NextResponse.json({ success: false, error: 'You do not belong to this workspace.' }, { status: 403 });

    if (scheduleId) {
      const { error } = await supabase.from('message_schedules').delete().eq('workspace_id', workspaceId).eq('id', scheduleId);
      if (error) throw error;
      return NextResponse.json({ success: true, deleted: 1 });
    }

    if (allStopped) {
      const { error } = await supabase
        .from('message_schedules')
        .delete()
        .eq('workspace_id', workspaceId)
        .or('status.in.(stopped,cancelled,failed,complete,completed),stop_requested.eq.true');
      if (error) throw error;
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: 'Choose one schedule or all stopped schedules.' }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ success: false, error: formatError(error) }, { status: 500 });
  }
}
