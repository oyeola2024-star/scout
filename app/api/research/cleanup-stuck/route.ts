import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { createClient } from '@/lib/supabase-server';

function errorMessage(error: unknown) {
  if (!error) return 'Unknown error';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

async function currentUserCanUseWorkspace(workspaceId: string) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return false;
  const { data: member, error: memberError } = await supabase
    .from('workspace_members')
    .select('workspace_id,user_id,approved')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .limit(1);
  if (memberError) throw memberError;
  return Boolean(member);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const workspaceId = String(body.workspaceId || '').trim();
    if (!workspaceId) return NextResponse.json({ success: false, error: 'Missing workspaceId.' }, { status: 400 });
    if (!(await currentUserCanUseWorkspace(workspaceId))) {
      return NextResponse.json({ success: false, error: 'You do not belong to this workspace.' }, { status: 403 });
    }

    const supabase = createAdminClient();
    const staleSince = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const { data: stale, error: readError } = await supabase
      .from('email_research_jobs')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('status', 'running')
      .lt('updated_at', staleSince);
    if (readError) throw readError;
    const ids = (stale || []).map((row: any) => row.id).filter(Boolean);
    if (ids.length) {
      const { error: updateError } = await supabase
        .from('email_research_jobs')
        .update({ status: 'queued', last_error: null, started_at: null, updated_at: new Date().toISOString() })
        .in('id', ids);
      if (updateError) throw updateError;
    }
    return NextResponse.json({ success: true, reset: ids.length });
  } catch (error) {
    return NextResponse.json({ success: false, error: errorMessage(error) }, { status: 500 });
  }
}
