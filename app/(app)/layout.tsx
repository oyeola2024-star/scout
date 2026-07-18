import { AppShellClient } from '@/components/AppShellClient';
import { NotificationBell } from '@/components/NotificationBell';
import { LiveActivityWindow } from '@/components/LiveActivityWindow';
import { AppOpenRunner } from '@/components/AppOpenRunner';
import { ScoutingLevel } from '@/components/ScoutingLevel';
import { createClient } from '@/lib/supabase-server';
import { getCurrentWorkspace } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { workspace } = await getCurrentWorkspace();


  return (
    <AppShellClient workspaceName={workspace?.name} userEmail={user?.email}>
      <main className="main">
        <div className="main-topbar">
          <div>
            <strong>Scout</strong>
            <span className="muted"> Simple lead sending</span>
          </div>
          <NotificationBell workspaceId={workspace?.id} />
        </div>
        <div className="container">{children}</div>
        <AppOpenRunner workspaceId={workspace?.id} />
        <ScoutingLevel workspaceId={workspace?.id} />
        <LiveActivityWindow workspaceId={workspace?.id} />
      </main>
    </AppShellClient>
  );
}
