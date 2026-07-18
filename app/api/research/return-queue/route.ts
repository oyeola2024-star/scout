import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { createClient } from '@/lib/supabase-server';

function errorMessage(error: unknown) {
  if (!error) return 'Unknown error';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    const e = error as { message?: string; code?: string; details?: string; hint?: string };
    return [e.message, e.code ? `Code: ${e.code}` : '', e.details ? `Details: ${e.details}` : '', e.hint ? `Hint: ${e.hint}` : ''].filter(Boolean).join(' | ') || JSON.stringify(error);
  } catch { return String(error); }
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
    const { data: jobs, error: jobReadError } = await supabase
      .from('email_research_jobs')
      .select('id,business_id,status')
      .eq('workspace_id', workspaceId)
      .in('status', ['queued']);
    if (jobReadError) throw jobReadError;

    const ids = (jobs || []).map((job: any) => job.id).filter(Boolean);
    const businessIds = Array.from(new Set((jobs || []).map((job: any) => job.business_id).filter(Boolean)));

    if (ids.length) {
      const { error: deleteError } = await supabase
        .from('email_research_jobs')
        .delete()
        .in('id', ids);
      if (deleteError) throw deleteError;
    }

    if (businessIds.length) {
      await supabase
        .from('businesses')
        .update({ status: 'review' })
        .in('id', businessIds as string[])
        .or('email.is.null,email.eq.');
    }

    return NextResponse.json({ success: true, returned: ids.length, businesses: businessIds.length });
  } catch (error) {
    return NextResponse.json({ success: false, error: errorMessage(error) }, { status: 500 });
  }
}
