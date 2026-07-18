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
    const workspaceId = String(body.workspaceId || '').trim();
    const id = String(body.id || '').trim();
    const all = Boolean(body.all);
    if (!workspaceId) return NextResponse.json({ success: false, error: 'Missing workspaceId.' }, { status: 400 });

    const { data: member, error: memberError } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .limit(1);
    if (memberError) throw memberError;
    if (!member?.length) return NextResponse.json({ success: false, error: 'You do not belong to this workspace.' }, { status: 403 });

    let query = supabase.from('app_notifications').update({ read_at: new Date().toISOString() }).eq('workspace_id', workspaceId).is('read_at', null);
    if (!all) {
      if (!id) return NextResponse.json({ success: false, error: 'Missing notification id.' }, { status: 400 });
      query = query.eq('id', id);
    }
    const { error } = await query;
    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: formatError(error) }, { status: 500 });
  }
}
