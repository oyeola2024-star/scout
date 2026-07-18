import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { requireWorkspaceAccess } from '@/lib/require-workspace-access';
import { validateEmailCandidate } from '@/lib/email-candidate-rules';

function errorMessage(error: unknown) {
  if (!error) return 'Unknown error';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function extractResearchText(raw: any) {
  try {
    const research = raw?.backend_email_research || raw?.email_research || raw || {};
    return JSON.stringify(research).slice(0, 2000);
  } catch {
    return '';
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const workspaceId = String(body.workspaceId || '').trim();
    const limit = Math.max(1, Math.min(5000, Number(body.limit || 1000)));
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

    let checked = 0;
    let quarantined = 0;
    const details: Array<Record<string, unknown>> = [];

    for (const business of rows || []) {
      checked += 1;
      const email = String((business as any).email || '').trim().toLowerCase();
      const sourceText = extractResearchText((business as any).raw);
      const decision = validateEmailCandidate({ email, sourceField: 'existing_business_email', sourceText }, business as any, '', false);
      if (!decision.valid || !decision.promote) {
        const raw = ((business as any).raw && typeof (business as any).raw === 'object') ? (business as any).raw : {};
        const quarantineRecord = {
          email,
          quarantined_at: new Date().toISOString(),
          reasons: decision.reasons,
          previous_status: (business as any).status
        };
        await supabase
          .from('businesses')
          .update({
            email: null,
            status: 'review',
            raw: { ...raw, quarantined_false_positive_email: quarantineRecord }
          })
          .eq('id', (business as any).id);
        await supabase
          .from('email_candidates')
          .update({ status: 'rejected_false_positive', raw: { quarantine: quarantineRecord } })
          .eq('workspace_id', workspaceId)
          .eq('business_id', (business as any).id)
          .eq('email', email);
        quarantined += 1;
        details.push({ businessId: (business as any).id, businessName: (business as any).name, email, reasons: decision.reasons });
      }
    }

    return NextResponse.json({ success: true, checked, quarantined, details: details.slice(0, 100) });
  } catch (error) {
    return NextResponse.json({ success: false, error: errorMessage(error) }, { status: 500 });
  }
}
