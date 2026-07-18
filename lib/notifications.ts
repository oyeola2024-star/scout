import type { SupabaseClient } from '@supabase/supabase-js';

type AnyRecord = Record<string, any>;

export type NotificationInput = {
  workspaceId: string;
  userId?: string | null;
  type: string;
  title: string;
  message?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  businessId?: string | null;
  raw?: AnyRecord | null;
};

export async function createAppNotification(supabase: SupabaseClient<any, any, any>, input: NotificationInput) {
  if (!input.workspaceId || !input.title) return null;
  const payload = {
    workspace_id: input.workspaceId,
    user_id: input.userId || null,
    type: input.type || 'info',
    title: input.title,
    message: input.message || null,
    entity_type: input.entityType || null,
    entity_id: input.entityId || null,
    business_id: input.businessId || null,
    raw: input.raw || {}
  };

  try {
    const query = supabase.from('app_notifications');
    if (input.entityType && input.entityId) {
      const { data, error } = await query.upsert(payload, { onConflict: 'workspace_id,type,entity_type,entity_id', ignoreDuplicates: true }).select('id').maybeSingle();
      if (error) throw error;
      return data || null;
    }
    const { data, error } = await query.insert(payload).select('id').maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (error) {
    // Do not let a missing migration or notification failure break Gmail sync / worker execution.
    console.warn('Scout notification skipped:', error);
    return null;
  }
}

export function notificationTitleForInbound(classification: string, fromEmail: string, businessName?: string | null) {
  const name = businessName || fromEmail || 'A lead';
  if (classification === 'real_reply') return `New reply from ${name}`;
  if (classification === 'auto_reply') return `Auto reply from ${name}`;
  if (classification === 'no_inbox') return `No inbox detected for ${name}`;
  if (classification === 'message_blocked') return `Message blocked for ${name}`;
  if (classification === 'bounce_notice') return `Bounce notice for ${name}`;
  if (classification === 'gmail_limit_notice') return 'Gmail sending limit notice';
  return `New inbound signal from ${name}`;
}
