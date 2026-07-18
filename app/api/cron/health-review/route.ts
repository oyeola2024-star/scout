export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { isCronAuthorized } from '@/lib/cron-auth';
import { reviewSenderHealth } from '@/lib/sender-health';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  if (!isCronAuthorized(request, body)) return NextResponse.json({ success: false, error: 'Invalid cron secret.' }, { status: 401 });
  try {
    const supabase = createAdminClient();
    await supabase.rpc('refresh_sender_today_counts');
    const limit = Math.max(1, Math.min(1000, Number(body.limit || 500)));
    const { data: accounts, error } = await supabase
      .from('gmail_accounts')
      .select('*')
      .order('last_health_review_at', { ascending: true, nullsFirst: true })
      .limit(limit);
    if (error) throw error;
    const results = [];
    for (const account of accounts || []) {
      try {
        const patch = await reviewSenderHealth(supabase as any, account);
        results.push({ id: account.id, email: account.email, success: true, stage: patch.health_stage, cap: patch.health_cap });
      } catch (error) {
        results.push({ id: account.id, email: account.email, success: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return NextResponse.json({ success: true, reviewed: results.length, results });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
