import UploadClient from './UploadClient';
import { getCurrentWorkspace } from '@/lib/workspace';

export default async function UploadPage() {
  const { workspace, error } = await getCurrentWorkspace();
  if (!workspace) return <div className="error">Workspace error: {error}</div>;
  return (
    <div className="stack">
      <div className="page-title">
        <h2>Upload Lists</h2>
        <p>Import up to 100,000 CSV contacts/businesses with chunked duplicate checks, invalid-row export, and Supabase queue storage.</p>
      </div>
      <UploadClient workspace={workspace} />
    </div>
  );
}
