import { createClient } from '@/lib/supabase-server';

export async function requireWorkspaceAccess(workspaceId: string) {
  if (!workspaceId) throw new Error('workspaceId is required.');
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    const error = new Error(userError?.message || 'Not signed in.') as Error & { status?: number };
    error.status = 401;
    throw error;
  }
  const { data: member, error: memberError } = await supabase
    .from('workspace_members')
    .select('workspace_id,user_id,approved')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .eq('approved', true)
    .maybeSingle();
  if (memberError) throw memberError;
  if (!member) {
    const error = new Error('You do not have access to this workspace.') as Error & { status?: number };
    error.status = 403;
    throw error;
  }
  return { user, supabase, member };
}
