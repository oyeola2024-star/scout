import Link from 'next/link';
import { getCurrentWorkspace } from '@/lib/workspace';
import MessageClient from './MessageClient';

export default async function MessagePage() {
  const { workspace, error } = await getCurrentWorkspace();
  if (!workspace) return <div className="error">Workspace error: {error}</div>;
  return (
    <div className="stack">
      <div className="page-title">
        <h2>Send Emails</h2>
        <p>Send first emails, send due follow-ups, or save a send for later. Keep Scout open when it is time to send.</p>
      </div>
      <div className="quick-links">
        <Link href="/templates" className="quick-link-card"><strong>Templates</strong><span>Write first emails and follow-up emails.</span></Link>
        <Link href="/help" className="quick-link-card"><strong>How to use</strong><span>Simple guide for every page and button.</span></Link>
      </div>
      <MessageClient workspace={workspace} />
    </div>
  );
}
