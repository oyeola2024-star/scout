import Link from 'next/link';
import { getCurrentWorkspace } from '@/lib/workspace';

const quickLinks = [
  { href: '/upload', title: 'Upload leads', desc: 'Add a CSV list.' },
  { href: '/auto-scout', title: 'Find missing emails', desc: 'Start, stop, and see results on one page.' },
  { href: '/verify', title: 'Clean emails', desc: 'Delete bad emails or redetect.' },
  { href: '/businesses', title: 'View all leads', desc: 'Open your lead list.' }
];

export default async function SourceScoutPage() {
  const { workspace, error } = await getCurrentWorkspace();
  if (!workspace) return <div className="error">Workspace error: {error}</div>;
  return (
    <div className="stack">
      <div className="page-title">
        <h2>Find Leads</h2>
        <p>Three simple actions: upload leads, find missing emails, then clean bad ones.</p>
      </div>
      <div className="quick-links">
        {quickLinks.map((link) => (
          <Link key={link.href} href={link.href} className="quick-link-card">
            <strong>{link.title}</strong>
            <span>{link.desc}</span>
          </Link>
        ))}
      </div>
      <div className="notice">Tip: Results from Find missing emails appear on that same page. Trusted emails are saved to your leads and can be used on Send Emails.</div>
    </div>
  );
}
