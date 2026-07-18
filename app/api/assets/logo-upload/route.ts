export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { createClient } from '@/lib/supabase-server';

const BUCKET = 'email-assets';
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function safeName(name: string) {
  return String(name || 'logo')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80) || 'logo';
}

async function ensureBucket(admin: ReturnType<typeof createAdminClient>) {
  const { data: buckets } = await admin.storage.listBuckets();
  const exists = (buckets || []).some((bucket) => bucket.name === BUCKET);
  if (!exists) {
    const { error } = await admin.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: MAX_LOGO_BYTES,
      allowedMimeTypes: Object.keys(ALLOWED_TYPES)
    });
    if (error && !String(error.message || '').toLowerCase().includes('already exists')) throw error;
  } else {
    await admin.storage.updateBucket(BUCKET, {
      public: true,
      fileSizeLimit: MAX_LOGO_BYTES,
      allowedMimeTypes: Object.keys(ALLOWED_TYPES)
    }).catch(() => undefined as any);
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return NextResponse.json({ success: false, error: userError?.message || 'Not signed in.' }, { status: 401 });

    const form = await request.formData();
    const workspaceId = String(form.get('workspace_id') || form.get('workspaceId') || '').trim();
    const file = form.get('logo');
    if (!workspaceId) return NextResponse.json({ success: false, error: 'workspace_id is required.' }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ success: false, error: 'Choose a logo image first.' }, { status: 400 });
    if (file.size <= 0) return NextResponse.json({ success: false, error: 'The selected logo file is empty.' }, { status: 400 });
    if (file.size > MAX_LOGO_BYTES) return NextResponse.json({ success: false, error: 'Logo is too large. Use an image under 2 MB.' }, { status: 400 });
    const contentType = String(file.type || '').toLowerCase();
    const ext = ALLOWED_TYPES[contentType];
    if (!ext) return NextResponse.json({ success: false, error: 'Use PNG, JPG, WebP, or GIF for email logos.' }, { status: 400 });

    const { data: member, error: memberError } = await supabase
      .from('workspace_members')
      .select('workspace_id,user_id,approved')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .limit(1);
    if (memberError) throw memberError;
    if (!member?.length) return NextResponse.json({ success: false, error: 'You do not belong to this workspace.' }, { status: 403 });

    const admin = createAdminClient();
    await ensureBucket(admin);

    const originalName = safeName(file.name || `logo.${ext}`);
    const path = `${workspaceId}/signature-logo-${Date.now()}-${originalName.replace(/\.[a-z0-9]+$/i, '')}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());
    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(path, buffer, { contentType, upsert: true, cacheControl: '31536000' });
    if (uploadError) throw uploadError;

    const { data: publicData } = admin.storage.from(BUCKET).getPublicUrl(path);
    const publicUrl = publicData.publicUrl;

    await admin
      .from('workspaces')
      .update({ email_logo_url: publicUrl, updated_at: new Date().toISOString() })
      .eq('id', workspaceId);

    return NextResponse.json({ success: true, bucket: BUCKET, path, publicUrl, logoUrl: publicUrl });
  } catch (error) {
    return NextResponse.json({ success: false, error: formatError(error) }, { status: 500 });
  }
}
