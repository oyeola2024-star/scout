export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { createClient as createServerSupabaseClient } from '@/lib/supabase-server';
import { hasUsableWebsiteTarget } from '@/lib/auto-scout-target';

function errorMessage(error: unknown) {
  if (!error) return 'Unknown error';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function workerSecretFromRequest(request: NextRequest, body?: Record<string, unknown>) {
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  return String(body?.token || request.nextUrl.searchParams.get('token') || request.nextUrl.searchParams.get('secret') || request.headers.get('x-auto-scout-worker-secret') || request.headers.get('x-cron-secret') || request.headers.get('x-worker-secret') || bearer || '');
}

async function signedInMemberCanRun(workspaceId: string) {
  if (!workspaceId) return false;
  try {
    const supabase = await createServerSupabaseClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return false;
    const { data: member, error: memberError } = await supabase
      .from('workspace_members')
      .select('workspace_id,user_id,approved')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .eq('approved', true)
      .limit(1);
    if (memberError) return false;
    return Boolean(member?.length);
  } catch {
    return false;
  }
}

function canAutoScoutStatus(status: unknown) {
  const blocked = new Set(['contacted', 'responded', 'bad_inbox', 'bounced', 'no_inbox', 'blocked', 'invalid', 'duplicate', 'archived', 'unsubscribed', 'do_not_contact', 'sent']);
  const value = String(status || '').trim().toLowerCase();
  return !blocked.has(value);
}

async function enqueuePendingNoEmail(workspaceId: string, limit: number) {
  const supabase = createAdminClient();
  const { data: businesses, error } = await supabase
    .from('businesses')
    .select('id,name,status,email,website,domain,raw,updated_at')
    .eq('workspace_id', workspaceId)
    .or('email.is.null,email.eq.')
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  const ids = (businesses || [])
    .filter((row: any) => canAutoScoutStatus(row.status) && hasUsableWebsiteTarget(row))
    .map((row) => row.id)
    .filter(Boolean);
  if (!ids.length) return { checked: 0, enqueued: 0 };
  const payload = ids.map((business_id) => ({
    workspace_id: workspaceId,
    business_id,
    status: 'queued',
    attempts: 0,
    priority: 100,
    requested_by: null
  }));
  const { data: jobs, error: jobError } = await supabase
    .from('email_research_jobs')
    .upsert(payload, { onConflict: 'workspace_id,business_id' })
    .select('id');
  if (jobError) throw jobError;
  return { checked: ids.length, enqueued: jobs?.length || 0 };
}

async function resetStaleRunning(workspaceId?: string) {
  const supabase = createAdminClient();
  const staleSince = new Date(Date.now() - 12 * 60 * 1000).toISOString();
  let query = supabase
    .from('email_research_jobs')
    .update({ status: 'queued', last_error: null, started_at: null, updated_at: new Date().toISOString() })
    .eq('status', 'running')
    .lt('updated_at', staleSince);
  if (workspaceId) query = query.eq('workspace_id', workspaceId);
  const { error } = await query;
  if (error) throw error;
}

async function runWorker(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const workspaceId = String(body.workspaceId || request.nextUrl.searchParams.get('workspaceId') || '').trim();
  if (!workspaceId) return NextResponse.json({ success: false, error: 'Missing workspaceId.' }, { status: 400 });

  const cronSecret = process.env.CRON_SECRET || process.env.AUTO_SCOUT_WORKER_SECRET || process.env.RUN_ALL_WORKER_SECRET || '';
  if (cronSecret) {
    const supplied = workerSecretFromRequest(request, body);
    const userAgent = request.headers.get('user-agent') || '';
    const isVercelCron = userAgent.toLowerCase().includes('vercel-cron');
    if (!isVercelCron && supplied !== cronSecret && !(await signedInMemberCanRun(workspaceId))) {
      return NextResponse.json({ success: false, error: 'Unauthorized Auto Scout worker request. Use a valid worker secret or run it while signed in.' }, { status: 401 });
    }
  }

  const cycles = Math.max(1, Math.min(2, Number(body.cycles || request.nextUrl.searchParams.get('cycles') || 1)));
  const batchSize = Math.max(1, Math.min(2, Number(body.batchSize || request.nextUrl.searchParams.get('batchSize') || 4)));
  const concurrency = Math.max(1, Math.min(2, Number(body.concurrency || request.nextUrl.searchParams.get('concurrency') || 2)));
  const enqueueLimit = Math.max(0, Math.min(50000, Number(body.enqueueLimit || request.nextUrl.searchParams.get('enqueueLimit') || 5000)));
  const autoEnqueue = body.autoEnqueue !== false && request.nextUrl.searchParams.get('autoEnqueue') !== 'false';

  await resetStaleRunning(workspaceId);
  const enqueue = autoEnqueue ? await enqueuePendingNoEmail(workspaceId, enqueueLimit) : { checked: 0, enqueued: 0 };

  const cycleResults: Array<Record<string, unknown>> = [];
  let processed = 0;
  let found = 0;
  let stoppedReason = '';

  for (let i = 0; i < cycles; i += 1) {
    const url = new URL('/api/research/run-once', request.nextUrl.origin);
    url.searchParams.set('limit', String(batchSize));
    url.searchParams.set('concurrency', String(concurrency));
    url.searchParams.set('workspaceId', workspaceId);
    if (cronSecret) url.searchParams.set('secret', cronSecret);

    const response = await fetch(url, { method: 'POST', headers: cronSecret ? { 'x-cron-secret': cronSecret } : undefined, cache: 'no-store' });
    const json: any = await response.json().catch(() => ({}));
    if (!response.ok || !json.success) {
      cycleResults.push({ cycle: i + 1, success: false, error: json?.error || `HTTP ${response.status}` });
      stoppedReason = json?.error || `run-once failed with HTTP ${response.status}`;
      break;
    }
    const cycleProcessed = Number(json.processed || 0);
    const cycleFound = Array.isArray(json.results) ? json.results.filter((row: any) => row?.email || row?.status === 'found').length : 0;
    processed += cycleProcessed;
    found += cycleFound;
    cycleResults.push({ cycle: i + 1, success: true, processed: cycleProcessed, found: cycleFound });
    if (!cycleProcessed) {
      stoppedReason = 'No queued jobs left.';
      break;
    }
  }

  return NextResponse.json({
    success: true,
    workspaceId,
    autoEnqueue,
    checkedForQueue: enqueue.checked,
    enqueued: enqueue.enqueued,
    cyclesRequested: cycles,
    cyclesRun: cycleResults.length,
    processed,
    found,
    stoppedReason: stoppedReason || 'Cycle limit reached.',
    cycleResults
  });
}

export async function GET(request: NextRequest) {
  try { return await runWorker(request); }
  catch (error) { return NextResponse.json({ success: false, error: errorMessage(error) }, { status: 500 }); }
}

export async function POST(request: NextRequest) {
  try { return await runWorker(request); }
  catch (error) { return NextResponse.json({ success: false, error: errorMessage(error) }, { status: 500 }); }
}
