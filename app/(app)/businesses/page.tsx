import Link from 'next/link';
import BusinessQueueClient from './BusinessQueueClient';
import { getCurrentWorkspace } from '@/lib/workspace';

export default async function BusinessesPage() {
  const { workspace, error } = await getCurrentWorkspace();
  if (!workspace) return <div className="error">{error || 'No workspace found.'}</div>;
  return (
    <div className="stack">
      <div className="page-title">
        <h2>Leads</h2>
        <p>All businesses you found, contacted, cleaned, or need to research.</p>
      </div>
      <div className="quick-links">
        <Link href="/source-scout" className="quick-link-card"><strong>Find more</strong><span>Add new leads.</span></Link>
        <Link href="/verify" className="quick-link-card"><strong>Clean emails</strong><span>Fix bad or missing emails.</span></Link>
      </div>
      <BusinessQueueClient workspace={workspace} />
    </div>
  );
}
