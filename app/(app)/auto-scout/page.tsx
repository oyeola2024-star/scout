import { getCurrentWorkspace } from '@/lib/workspace';
import AutoScoutClient from './AutoScoutClient';

export default async function AutoScoutPage() {
  const { workspace, error } = await getCurrentWorkspace();
  if (!workspace) return <div className="error">Workspace error: {error}</div>;
  return (
    <div className="stack">
      <div className="page-title"><h2>Find Missing Emails</h2><p>One clear button: Scout uses the saved website URL, checks real website pages, and saves trusted emails.</p></div>
      <AutoScoutClient workspace={workspace} />
    </div>
  );
}
