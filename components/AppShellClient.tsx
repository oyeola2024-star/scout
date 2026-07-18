'use client';

import { Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AppNav } from '@/components/AppNav';
import { SignOutButton } from '@/components/SignOutButton';

export function AppShellClient({
  children,
  workspaceName,
  userEmail,
}: {
  children: React.ReactNode;
  workspaceName?: string | null;
  userEmail?: string | null;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem('scout_sidebar_open');
    if (saved === '0') setSidebarOpen(false);
  }, []);

  function toggleSidebar() {
    setSidebarOpen((current) => {
      const next = !current;
      if (typeof window !== 'undefined') window.localStorage.setItem('scout_sidebar_open', next ? '1' : '0');
      return next;
    });
  }

  return (
    <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <aside className="sidebar">
        <button className="sidebar-toggle inside" type="button" onClick={toggleSidebar} aria-label="Close menu">
          <X size={18} />
        </button>
        <div className="brand">
          <div className="logo" />
          <div>
            <h1>Scout</h1>
            <p>{workspaceName || 'No workspace'}</p>
          </div>
        </div>
        <AppNav />
        <div style={{ marginTop: 22, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
          <p className="muted" style={{ fontSize: 12, wordBreak: 'break-word' }}>{userEmail}</p>
          <SignOutButton />
        </div>
      </aside>
      <button className="sidebar-toggle floating" type="button" onClick={toggleSidebar} aria-label="Open menu">
        <Menu size={18} />
        <span>Menu</span>
      </button>
      {children}
    </div>
  );
}
