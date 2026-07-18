import { getCurrentWorkspace } from '@/lib/workspace';
import TemplateLibraryClient from './TemplateLibraryClient';

export default async function TemplatesPage() {
  const { workspace, error } = await getCurrentWorkspace();
  if (!workspace) return <div className="error">Workspace error: {error}</div>;
  return (
    <div className="stack">
      <div className="page-title">
        <h2>Templates</h2>
        <p>Create message categories and save multiple templates inside each category.</p>
      </div>
      <TemplateLibraryClient workspace={workspace} />
    </div>
  );
}
