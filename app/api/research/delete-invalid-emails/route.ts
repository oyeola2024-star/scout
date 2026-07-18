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

function looksBad(email: string) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return false;
  if (!/^[-a-z0-9._%+]+@[-a-z0-9.]+\.[a-z]{2,}$/i.test(e)) return true;
  if (['abc@xyz.com', 'test@test.com', 'email@example.com', 'ton-courriel@exemple.com'].includes(e)) return true;
  if (e.includes('chimpst@ic.com') || e.includes('maps.gst@ic.com') || e.includes('instagram.pin@')) return true;
  if (e.startsWith('www.') || e.includes('@example.') || e.includes('@exemple.')) return true;
  if (e.includes('@ic.com') && !e.includes('music')) return true;
  if (/apps?\d*\./.test(e.split('@')[0] || '')) return true;
  return false;
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return NextResponse.json({ success: false, error: userError?.message || 'Not signed in.' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const workspaceId = String(body.workspaceId || body.workspace_id || '').trim();
    const limit = Math.max(1, Math.min(50000, Number(body.limit || 5000)));
    if (!workspaceId) return NextResponse.json({ success: false, error: 'Missing workspaceId.' }, { status: 400 });

    const { data: member, error: memberError } = await supabase
      .from('workspace_members')
      .select('workspace_id,user_id,approved')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .limit(1);
    if (memberError) throw memberError;
    if (!member?.length) return NextResponse.json({ success: false, error: 'You do not belong to this workspace.' }, { status: 403 });

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('businesses')
      .select('id,email,raw')
      .eq('workspace_id', workspaceId)
      .not('email', 'is', null)
      .limit(limit);
    if (error) throw error;

    const bad = (data || []).filter((row: any) => looksBad(row.email));
    const now = new Date().toISOString();
    for (let i = 0; i < bad.length; i += 500) {
      const chunk = bad.slice(i, i + 500);
      for (const row of chunk) {
        const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
        const { error: updateError } = await admin
          .from('businesses')
          .update({
            email: null,
            status: 'pending',
            raw: { ...raw, removed_invalid_email: row.email, invalid_email_removed_at: now },
            updated_at: now,
          })
          .eq('workspace_id', workspaceId)
          .eq('id', row.id);
        if (updateError) throw updateError;
      }
    }

    return NextResponse.json({ success: true, checked: (data || []).length, updated: bad.length });
  } catch (error) {
    return NextResponse.json({ success: false, error: formatError(error) }, { status: 500 });
  }
}
