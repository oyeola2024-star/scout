import { createClient } from './supabase-server';
import { Workspace } from './types';

type WorkspaceMembershipRow = {
  role?: string | null;
  workspaces?: Workspace | Workspace[] | null;
};

function firstWorkspace(value: unknown): Workspace | null {
  if (Array.isArray(value)) return (value[0] || null) as Workspace | null;
  return value && typeof value === 'object' ? (value as Workspace) : null;
}

export async function getCurrentWorkspace(): Promise<{ workspace: Workspace | null; error?: string }> {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return { workspace: null, error: 'Not signed in' };

  // v10.33 uses a read-only SECURITY DEFINER RPC that returns the signed-in
  // user's own workspace. Account creation/repair remains in the database
  // trigger and one-time recovery migration, not in normal page rendering.
  const { data: rpcRows, error: rpcError } = await supabase.rpc('current_scout_workspace');
  const rpcWorkspace = firstWorkspace(rpcRows);
  if (!rpcError && rpcWorkspace?.id) return { workspace: rpcWorkspace };

  // Compatibility fallback while the recovery SQL is being installed.
  // Do not use .single()/.maybeSingle(), and do not use approval as an access gate.
  const { data, error } = await supabase
    .from('workspace_members')
    .select('role, workspaces(id, name, api_key, app_url, default_audience_category_id, default_audience_category_name, dork_settings, extension_settings, email_signature_text, email_signature_html, email_logo_url)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(10);

  if (error) return { workspace: null, error: rpcError?.message || error.message };

  for (const row of (data || []) as WorkspaceMembershipRow[]) {
    const workspace = firstWorkspace(row.workspaces);
    if (workspace?.id) return { workspace };
  }

  return {
    workspace: null,
    error: rpcError?.message || 'Workspace setup is unavailable for this account. Please sign out and sign in again.'
  };
}
