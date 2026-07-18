import NotificationsClient from './NotificationsClient';
import { getCurrentWorkspace } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const { workspace } = await getCurrentWorkspace();
  if (!workspace) return <div className="card"><h2>No workspace</h2><p className="muted">Sign out and sign in again. If the problem continues, re-run the fresh database installation SQL.</p></div>;
  return <NotificationsClient workspace={workspace} />;
}
