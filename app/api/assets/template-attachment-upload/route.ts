export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-admin';
import { createClient } from '@/lib/supabase-server';

const BUCKET = 'message-attachments';
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function safeName(name: string) {
  return String(name || 'attachment')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 120) || 'attachment';
}

async function ensureBucket(admin: ReturnType<typeof createAdminClient>) {
  const { data: buckets } = await admin.storage.listBuckets();
  const exists = (buckets || []).some((bucket) => bucket.name === BUCKET);
  const config = {
    public: true,
    fileSizeLimit: MAX_ATTACHMENT_BYTES,
    allowedMimeTypes: Object.keys(ALLOWED_TYPES),
  };
  if (!exists) {
    const { error } = await admin.storage.createBucket(BUCKET, config);
    if (error && !String(error.message || '').toLowerCase().includes('already exists')) throw error;
  } else {
    await admin.storage.updateBucket(BUCKET, config).catch(() => undefined as any);
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return NextResponse.json({ success: false, error: userError?.message || 'Not signed in.' }, { status: 401 });

    const form = await request.formData();
    const workspaceId = String(form.get('workspace_id') || form.get('workspaceId') || '').trim();
    const templateId = String(form.get('template_id') || form.get('templateId') || 'new-template').trim() || 'new-template';
    const file = form.get('attachment');
    if (!workspaceId) return NextResponse.json({ success: false, error: 'workspace_id is required.' }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ success: false, error: 'Choose a file first.' }, { status: 400 });
    if (file.size <= 0) return NextResponse.json({ success: false, error: 'The selected file is empty.' }, { status: 400 });
    if (file.size > MAX_ATTACHMENT_BYTES) return NextResponse.json({ success: false, error: 'File is too large. Use a file under 10 MB.' }, { status: 400 });
    const contentType = String(file.type || 'application/octet-stream').toLowerCase();
    const ext = ALLOWED_TYPES[contentType];
    if (!ext) return NextResponse.json({ success: false, error: 'Use PDF, image, TXT, CSV, DOCX, XLSX, or PPTX files only.' }, { status: 400 });

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

    const originalName = safeName(file.name || `attachment.${ext}`);
    const base = originalName.replace(/\.[a-z0-9]+$/i, '');
    const path = `${workspaceId}/${safeName(templateId)}/${Date.now()}-${base}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());
    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(path, buffer, { contentType, upsert: true, cacheControl: '31536000' });
    if (uploadError) throw uploadError;

    const { data: publicData } = admin.storage.from(BUCKET).getPublicUrl(path);
    const publicUrl = publicData.publicUrl;
    return NextResponse.json({
      success: true,
      attachment: {
        name: originalName,
        filename: originalName,
        public_url: publicUrl,
        url: publicUrl,
        mime_type: contentType,
        size_bytes: file.size,
        storage_path: path,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: formatError(error) }, { status: 500 });
  }
}
