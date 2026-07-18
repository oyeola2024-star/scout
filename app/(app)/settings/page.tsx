import SettingsClient from './SettingsClient';
import { getCurrentWorkspace } from '@/lib/workspace';

export default async function SettingsPage() {
  const { workspace, error } = await getCurrentWorkspace();
  if (!workspace) return <div className="error">Workspace error: {error}</div>;
  return (
    <div className="stack">
      <div className="page-title"><h2>Settings</h2><p>Connect Gmail, set your limits, signature, app URL and extension key.</p></div>
      <SettingsClient workspace={workspace} />
    </div>
  );
}
