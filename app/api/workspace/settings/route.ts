import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { createAdminClient } from '@/lib/supabase-admin';

function cleanUrl(value: unknown) {
  let url = String(value || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/$/, '');
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return 'Unknown error'; }
}

async function assertMember(workspaceId: string) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return { error: userError?.message || 'Not signed in.', status: 401 } as const;
  const { data: member, error } = await supabase
    .from('workspace_members')
    .select('workspace_id,user_id,approved,role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .limit(1);
  if (error) return { error: error.message, status: 500 } as const;
  if (!member?.length) return { error: 'You do not belong to this workspace.', status: 403 } as const;
  return { user, member } as const;
}

export async function GET(request: NextRequest) {
  try {
    const workspaceId = request.nextUrl.searchParams.get('workspaceId') || '';
    if (!workspaceId) return NextResponse.json({ success: false, error: 'Missing workspaceId.' }, { status: 400 });
    const allowed = await assertMember(workspaceId);
    if ('error' in allowed) return NextResponse.json({ success: false, error: allowed.error }, { status: allowed.status });
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('workspaces')
      .select('id,name,api_key,app_url,default_audience_category_id,default_audience_category_name,dork_settings,extension_settings,email_signature_text,email_signature_html,email_logo_url')
      .eq('id', workspaceId)
      .single();
    if (error) throw error;
    return NextResponse.json({ success: true, workspace: data });
  } catch (error) {
    return NextResponse.json({ success: false, error: errorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const workspaceId = String(body.workspaceId || '');
    if (!workspaceId) return NextResponse.json({ success: false, error: 'Missing workspaceId.' }, { status: 400 });
    const allowed = await assertMember(workspaceId);
    if ('error' in allowed) return NextResponse.json({ success: false, error: allowed.error }, { status: allowed.status });


    const admin = createAdminClient();
    let defaultCategoryId = body.defaultAudienceCategoryId ? String(body.defaultAudienceCategoryId) : null;
    let defaultCategoryName = String(body.defaultAudienceCategoryName || '').trim();

    if (!defaultCategoryId && defaultCategoryName) {
      const { data: existing, error: findError } = await admin
        .from('message_categories')
        .select('id,name')
        .eq('workspace_id', workspaceId)
        .ilike('name', defaultCategoryName)
        .maybeSingle();
      if (findError) throw findError;
      if (existing?.id) {
        defaultCategoryId = existing.id;
        defaultCategoryName = existing.name || defaultCategoryName;
      } else {
        const { data: created, error: createError } = await admin
          .from('message_categories')
          .insert({ workspace_id: workspaceId, name: defaultCategoryName, description: 'Default audience category from workspace setup.', active: true, created_by: allowed.user.id })
          .select('id,name')
          .single();
        if (createError) throw createError;
        defaultCategoryId = created.id;
        defaultCategoryName = created.name || defaultCategoryName;
      }
    }

    if (defaultCategoryId) {
      const { data: category, error: categoryError } = await admin
        .from('message_categories')
        .select('id,name')
        .eq('workspace_id', workspaceId)
        .eq('id', defaultCategoryId)
        .maybeSingle();
      if (categoryError) throw categoryError;
      if (category?.name) defaultCategoryName = category.name;
    }

    const patch = {
      app_url: cleanUrl(body.appUrl),
      default_audience_category_id: defaultCategoryId,
      default_audience_category_name: defaultCategoryName || null,
      extension_settings: {
        extension_repo: 'https://github.com/damolax/scout-extension',
        scout_app_repo: 'https://github.com/damolax/Scout-app',
        notes: 'Share app_url and api_key with the browser extension setup.',
        updated_at: new Date().toISOString()
      },
      updated_at: new Date().toISOString()
    };

    const { data, error } = await admin.from('workspaces').update(patch).eq('id', workspaceId).select('id,name,api_key,app_url,default_audience_category_id,default_audience_category_name,dork_settings,extension_settings,email_signature_text,email_signature_html,email_logo_url').single();
    if (error) throw error;


    await admin.from('activity_logs').insert({
      workspace_id: workspaceId,
      type: 'workspace_settings_saved',
      message: 'Workspace setup URLs/default category were saved.',
      raw: { appUrl: patch.app_url, defaultAudienceCategoryName: defaultCategoryName },
      created_by: allowed.user.id
    });

    return NextResponse.json({ success: true, workspace: data });
  } catch (error) {
    return NextResponse.json({ success: false, error: errorMessage(error) }, { status: 500 });
  }
}
