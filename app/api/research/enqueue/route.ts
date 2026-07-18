import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { hasUsableWebsiteTarget } from '@/lib/auto-scout-target';

function errorMessage(error: unknown) {
  if (!error) return 'Unknown error';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    const e = error as { message?: string; code?: string; details?: string; hint?: string };
    return [e.message, e.code ? `Code: ${e.code}` : '', e.details ? `Details: ${e.details}` : '', e.hint ? `Hint: ${e.hint}` : ''].filter(Boolean).join(' | ') || JSON.stringify(error);
  } catch { return String(error); }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return NextResponse.json({ success: false, error: userError?.message || 'Not signed in.' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const workspaceId = String(body.workspaceId || '');
    const limit = Math.max(1, Math.min(50000, Number(body.limit || 5000)));
    const businessIds = Array.isArray(body.businessIds) ? body.businessIds.map(String).filter(Boolean).slice(0, limit) : [];
    const importBatchId = typeof body.importBatchId === 'string' ? body.importBatchId : '';
    const noEmailOnly = Boolean(body.noEmailOnly);

    if (!workspaceId) return NextResponse.json({ success: false, error: 'Missing workspaceId.' }, { status: 400 });

    const { data: member, error: memberError } = await supabase
      .from('workspace_members')
      .select('workspace_id,user_id,approved')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .limit(1);
    if (memberError) throw memberError;
    if (!member?.length) return NextResponse.json({ success: false, error: 'You do not belong to this workspace.' }, { status: 403 });

    let query = supabase
      .from('businesses')
      .select('id,name,status,email,website,domain,raw')
      .eq('workspace_id', workspaceId)
      .limit(limit);

    if (noEmailOnly) query = query.or('email.is.null,email.eq.');

    if (importBatchId) query = query.eq('import_batch_id', importBatchId);
    if (businessIds.length) query = supabase.from('businesses').select('id,name,status,email,website,domain,raw').eq('workspace_id', workspaceId).in('id', businessIds).limit(limit);

    const { data: businesses, error: businessError } = await query;
    if (businessError) throw businessError;

    const blockedStatuses = new Set(['contacted', 'responded', 'bad_inbox', 'bounced', 'no_inbox', 'blocked', 'invalid', 'duplicate', 'archived', 'unsubscribed', 'do_not_contact', 'sent']);
    const ids = (businesses || [])
      .filter((b: any) => !blockedStatuses.has(String(b.status || '').trim().toLowerCase()))
      .filter((b: any) => !noEmailOnly || !String(b.email || '').trim())
      // Auto Scout is website-first. Do not queue rows that only have a business name, Yelp/Google page, or IP address.
      .filter((b: any) => hasUsableWebsiteTarget(b))
      .map((b) => b.id);
    if (!ids.length) return NextResponse.json({ success: true, enqueued: 0, message: 'No pending businesses found to enqueue.' });

    const payload = ids.map((id) => ({
      workspace_id: workspaceId,
      business_id: id,
      status: 'queued',
      attempts: 0,
      priority: 100,
      requested_by: user.id
    }));

    const { data: jobs, error: jobError } = await supabase
      .from('email_research_jobs')
      .upsert(payload, { onConflict: 'workspace_id,business_id' })
      .select('id');
    if (jobError) throw jobError;

    return NextResponse.json({ success: true, enqueued: jobs?.length || 0, checked: ids.length });
  } catch (error) {
    return NextResponse.json({ success: false, error: errorMessage(error), raw: error }, { status: 500 });
  }
}
