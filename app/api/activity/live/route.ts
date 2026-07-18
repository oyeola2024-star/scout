export const runtime = 'nodejs';
export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

async function safeQuery<T>(fn: () => any, fallback: T): Promise<T> {
  try {
    const { data, error } = await fn();
    if (error) return fallback;
    return data || fallback;
  } catch {
    return fallback;
  }
}

function normalizeLiveEvent(row: any, source: 'send' | 'auto_scout') {
  const raw = row?.raw && typeof row.raw === 'object' ? row.raw : {};
  return {
    id: `${source}_${row.id}`,
    kind: source,
    status: String(row.type || row.status || 'info'),
    title: source === 'send'
      ? (String(row.type || '').includes('sent') || String(row.type || '') === 'sent' ? 'Message sent' : String(row.type || '') === 'sending' ? 'Sending message' : 'Email work')
      : (String(row.type || '').includes('found') ? 'Email found' : String(row.type || '').includes('checking') || String(row.type || '').includes('deep') ? 'Auto Scout checking' : 'Auto Scout'),
    message: String(row.message || ''),
    toEmail: String(raw.to_email || raw.to || ''),
    fromEmail: String(raw.from_email || raw.from || ''),
    businessName: String(raw.business_name || raw.business || ''),
    website: String(raw.website || raw.evidence || ''),
    countText: raw.current && raw.target ? `${Number(raw.current).toLocaleString()} / ${Number(raw.target).toLocaleString()}` : (raw.pages_checked ? `${Number(raw.pages_checked).toLocaleString()} page(s)` : ''),
    createdAt: row.created_at || new Date().toISOString()
  };
}

export async function GET(request: NextRequest) {
  try {
    const workspaceId = String(request.nextUrl.searchParams.get('workspaceId') || '').trim();
    if (!workspaceId) return NextResponse.json({ success: false, error: 'workspaceId is required.' }, { status: 400 });

    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return NextResponse.json({ success: false, error: userError?.message || 'Not signed in.' }, { status: 401 });

    const { data: member, error: memberError } = await supabase
      .from('workspace_members')
      .select('workspace_id,user_id,approved')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .limit(1);
    if (memberError) throw memberError;
    if (!member?.length) return NextResponse.json({ success: false, error: 'You do not belong to this workspace.' }, { status: 403 });

    const admin = createAdminClient();
    const now = Date.now();
    const recentSince = new Date(now - 15 * 60 * 1000).toISOString();
    const freshSentSince = new Date(now - 5 * 60 * 1000).toISOString();

    const schedulesRaw = await safeQuery<any[]>(() => admin
      .from('message_schedules')
      .select('id,type,status,run_kind,target_count,processed_count,sent_count,failed_count,skipped_count,scheduled_for,updated_at,last_heartbeat_at,stop_requested,last_error')
      .eq('workspace_id', workspaceId)
      .in('status', ['scheduled', 'due', 'running'])
      .order('updated_at', { ascending: false })
      .limit(12), []);

    const schedules = schedulesRaw.filter((row) => {
      if (row.stop_requested) return false;
      const status = String(row.status || '');
      if (status === 'running' || status === 'due') return true;
      const scheduledFor = row.scheduled_for ? new Date(row.scheduled_for).getTime() : 0;
      return status === 'scheduled' && scheduledFor > 0 && scheduledFor <= now + 60_000;
    });

    const outreachEvents = await safeQuery<any[]>(() => admin
      .from('outreach_events')
      .select('id,type,message,raw,created_at,business_id,gmail_account_id')
      .eq('workspace_id', workspaceId)
      .gte('created_at', recentSince)
      .in('type', ['sending', 'sent', 'dry_run', 'failed', 'message_blocked', 'limit_hit', 'sender_limit'])
      .order('created_at', { ascending: false })
      .limit(40), []);

    const scoutEvents = await safeQuery<any[]>(() => admin
      .from('activity_logs')
      .select('id,type,message,raw,created_at')
      .eq('workspace_id', workspaceId)
      .gte('created_at', recentSince)
      .like('type', 'auto_scout%')
      .order('created_at', { ascending: false })
      .limit(40), []);

    const sent = await safeQuery<any[]>(() => admin
      .from('sent_messages')
      .select('id,status,to_email,from_email,subject,sent_at,created_at')
      .eq('workspace_id', workspaceId)
      .gte('sent_at', freshSentSince)
      .order('sent_at', { ascending: false })
      .limit(10), []);

    const researchJobsRaw = await safeQuery<any[]>(() => admin
      .from('email_research_jobs')
      .select('id,business_id,status,attempts,last_error,updated_at,created_at,finished_at')
      .eq('workspace_id', workspaceId)
      .in('status', ['queued', 'running'])
      .order('updated_at', { ascending: false })
      .limit(12), []);

    const researchJobs = researchJobsRaw.filter((row) => String(row.status || '') === 'running' || new Date(row.updated_at || row.created_at || 0).getTime() >= now - 15 * 60 * 1000);

    const liveEvents = [
      ...outreachEvents.map((row) => normalizeLiveEvent(row, 'send')),
      ...scoutEvents.map((row) => normalizeLiveEvent(row, 'auto_scout')),
      ...sent.map((row) => ({
        id: `recent_sent_${row.id}`,
        kind: 'send',
        status: String(row.status || 'sent'),
        title: 'Message sent',
        message: `Message sent to ${row.to_email || ''}`,
        toEmail: row.to_email || '',
        fromEmail: row.from_email || '',
        businessName: '',
        website: '',
        countText: '',
        createdAt: row.sent_at || row.created_at || new Date().toISOString()
      }))
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 60);

    return NextResponse.json({
      success: true,
      schedules,
      researchJobs,
      liveEvents,
      // kept for compatibility, but v9 does not render old history as live work
      recentSent: sent,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: formatError(error) }, { status: 500 });
  }
}
