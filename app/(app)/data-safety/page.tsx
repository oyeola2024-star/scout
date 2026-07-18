import DataSafetyClient from './DataSafetyClient';
import { getCurrentWorkspace } from '@/lib/workspace';

export default async function DataSafetyPage() {
  const { workspace, error } = await getCurrentWorkspace();
  if (!workspace) return <div className="error">Workspace error: {error}</div>;
  return (
    <div className="stack">
      <div className="page-title"><h2>Data Safety</h2><p>Backup, recover, and migrate your old local Scout history into the cloud.</p></div>
      <DataSafetyClient workspace={workspace} />
    </div>
  );
}
