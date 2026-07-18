import { getCurrentWorkspace } from '@/lib/workspace';
import VerifyClient from './VerifyClient';

export default async function VerifyPage() {
  const { workspace, error } = await getCurrentWorkspace();
  if (!workspace) return <div className="error">Workspace error: {error}</div>;
  return (
    <div className="stack">
      <div className="page-title">
        <h2>Ready Email Detection</h2>
        <p>No paid verifier. Contacts with valid business or personal emails are marked Ready; no-email contacts remain Pending for Auto Scout; bounces/no-inbox are cleaned after sending.</p>
      </div>
      <VerifyClient workspace={workspace} />
    </div>
  );
}
