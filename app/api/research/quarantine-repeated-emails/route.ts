import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { requireWorkspaceAccess } from '@/lib/require-workspace-access';
import { duplicateEmailRisk } from '@/lib/repeated-email-guard';

function errorMessage(error: unknown) {
  if (!error) return 'Unknown error';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function normalizeEmail(email: unknown) {
  return String(email || '').trim().toLowerCase();
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const workspaceId = String(body.workspaceId || '').trim();
    const limit = Math.max(1, Math.min(50000, Number(body.limit || 10000)));
    if (!workspaceId) return NextResponse.json({ success: false, error: 'workspaceId is required.' }, { status: 400 });
    await requireWorkspaceAccess(workspaceId);

    const supabase = createAdminClient();
    const { data: rows, error } = await supabase
      .from('businesses')
      .select('id,workspace_id,name,email,website,domain,status,raw')
      .eq('workspace_id', workspaceId)
      .not('email', 'is', null)
      .neq('email', '')
      .in('status', ['found', 'ready', 'review', 'scanning'])
      .limit(limit);
    if (error) throw error;

    const groups = new Map<string, any[]>();
    for (const row of rows || []) {
      const email = normalizeEmail((row as any).email);
      if (!email) continue;
      const group = groups.get(email) || [];
      group.push(row);
      groups.set(email, group);
    }

    let checkedGroups = 0;
    let checkedRows = 0;
    let quarantined = 0;
    const repeated: Array<Record<string, unknown>> = [];

    for (const [email, group] of groups.entries()) {
      if (group.length < 2) continue;
      checkedGroups += 1;
      for (const row of group) {
        checkedRows += 1;
        const others = group.filter((item) => item.id !== row.id);
        const risk = duplicateEmailRisk(email, row, others);
        if (!risk.risky) continue;
        const raw = ((row as any).raw && typeof (row as any).raw === 'object') ? (row as any).raw : {};
        const record = {
          email,
          quarantined_at: new Date().toISOString(),
          reason: risk.reason,
          duplicate_email_guard: risk,
          previous_status: (row as any).status
        };
        await supabase
          .from('businesses')
          .update({ email: null, status: 'review', raw: { ...raw, repeated_email_guard: record } })
          .eq('id', (row as any).id);
        await supabase
          .from('email_candidates')
          .update({ status: 'rejected_repeated_across_unrelated_businesses', raw: { repeated_email_guard: record } })
          .eq('workspace_id', workspaceId)
          .eq('business_id', (row as any).id)
          .eq('email', email);
        quarantined += 1;
        repeated.push({ businessId: row.id, businessName: row.name, email, reason: risk.reason, roots: risk.otherRoots });
      }
    }

    return NextResponse.json({ success: true, checkedGroups, checkedRows, quarantined, repeated: repeated.slice(0, 200) });
  } catch (error) {
    return NextResponse.json({ success: false, error: errorMessage(error) }, { status: 500 });
  }
}
