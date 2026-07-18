import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';

const DEFAULT_SIGNALS = [
  '{industry} {location} "contact us" "email"',
  '{industry} {location} "about us" "@"',
  '{industry} {location} "we are hiring" "contact"',
  '{industry} {location} "new location" "contact"',
  '{industry} {location} "opening hours" "email"',
  '{industry} {location} "get a quote" "email"'
];

function normalizeSettings(input: any) {
  const signals = Array.isArray(input?.signals) ? input.signals : String(input?.signals || '').split('\n');
  const resultsRaw = Number(input?.resultsPerSignal || input?.results_per_signal || 30);
  const delayRaw = Number(input?.delayBetweenPages || input?.delay_between_pages || 8000);
  return {
    industry: String(input?.industry || '').trim(),
    location: String(input?.location || '').trim(),
    audienceCategoryId: String(input?.audienceCategoryId || input?.audience_category_id || '').trim(),
    audienceCategoryName: String(input?.audienceCategoryName || input?.audience_category_name || input?.category || '').trim(),
    engine: String(input?.engine || 'bing').trim() || 'bing',
    resultsPerSignal: Math.max(1, Math.min(100, Number.isFinite(resultsRaw) ? resultsRaw : 30)),
    delayBetweenPages: Math.max(500, Math.min(60000, Number.isFinite(delayRaw) ? delayRaw : 8000)),
    signals: signals.map((s: unknown) => String(s || '').trim()).filter(Boolean).slice(0, 200)
  };
}

async function workspaceFromKey(request: NextRequest, body?: any) {
  const apiKey = String(request.headers.get('x-scout-workspace-key') || body?.workspaceKey || body?.workspace_key || '').trim();
  if (!apiKey) return { error: 'Missing workspace key', status: 401 } as const;
  const admin = createAdminClient();
  const { data: workspace, error } = await admin
    .from('workspaces')
    .select('id,dork_settings,default_audience_category_id,default_audience_category_name')
    .eq('api_key', apiKey)
    .single();
  if (error || !workspace) return { error: 'Invalid workspace key', status: 403 } as const;
  return { admin, workspace } as const;
}

export async function GET(request: NextRequest) {
  const resolved = await workspaceFromKey(request);
  if ('error' in resolved) return NextResponse.json({ success: false, error: resolved.error }, { status: resolved.status });
  const saved = resolved.workspace.dork_settings || {};
  const settings = normalizeSettings({
    signals: DEFAULT_SIGNALS,
    ...(typeof saved === 'object' ? saved : {}),
    audienceCategoryId: (saved as any)?.audienceCategoryId || resolved.workspace.default_audience_category_id || '',
    audienceCategoryName: (saved as any)?.audienceCategoryName || resolved.workspace.default_audience_category_name || ''
  });
  return NextResponse.json({ success: true, settings });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const resolved = await workspaceFromKey(request, body);
  if ('error' in resolved) return NextResponse.json({ success: false, error: resolved.error }, { status: resolved.status });
  const settings = normalizeSettings(body);
  let audienceCategoryId = settings.audienceCategoryId || '';
  let audienceCategoryName = settings.audienceCategoryName || '';
  if (!audienceCategoryId && audienceCategoryName) {
    const { data: existing } = await resolved.admin
      .from('message_categories')
      .select('id,name')
      .eq('workspace_id', resolved.workspace.id)
      .ilike('name', audienceCategoryName)
      .maybeSingle();
    if (existing?.id) {
      audienceCategoryId = existing.id;
      audienceCategoryName = existing.name || audienceCategoryName;
    } else {
      const { data: created, error: createError } = await resolved.admin
        .from('message_categories')
        .insert({ workspace_id: resolved.workspace.id, name: audienceCategoryName, description: 'Audience category created from extension dorking settings.', active: true })
        .select('id,name')
        .single();
      if (!createError && created?.id) {
        audienceCategoryId = created.id;
        audienceCategoryName = created.name || audienceCategoryName;
      }
    }
  }
  const finalSettings = { ...settings, audienceCategoryId, audienceCategoryName, updatedAt: new Date().toISOString() };
  await resolved.admin
    .from('workspaces')
    .update({
      dork_settings: finalSettings,
      default_audience_category_id: audienceCategoryId || resolved.workspace.default_audience_category_id || null,
      default_audience_category_name: audienceCategoryName || resolved.workspace.default_audience_category_name || null,
      updated_at: new Date().toISOString()
    })
    .eq('id', resolved.workspace.id);
  await resolved.admin.from('activity_logs').insert({
    workspace_id: resolved.workspace.id,
    type: 'extension_dork_settings_saved',
    message: `Extension dorking settings saved${audienceCategoryName ? ` for ${audienceCategoryName}` : ''}.`,
    raw: { settings: finalSettings }
  });
  return NextResponse.json({ success: true, settings: finalSettings });
}
