'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BarChart3, Search, Mail, Inbox, Settings, HelpCircle, Trophy } from 'lucide-react';

const items = [
  { href: '/dashboard', label: 'Home', icon: BarChart3 },
  { href: '/source-scout', label: 'Find Leads', icon: Search },
  { href: '/message', label: 'Send Emails', icon: Mail },
  { href: '/replies', label: 'Replies', icon: Inbox },
  { href: '/settings', label: 'Settings', icon: Settings },
  { href: '/challenges', label: 'Challenges', icon: Trophy },
  { href: '/help', label: 'How to Use', icon: HelpCircle }
];

const groupedRoutes: Record<string, string[]> = {
  '/dashboard': ['/dashboard'],
  '/source-scout': ['/source-scout', '/upload', '/auto-scout', '/email-scout', '/verify', '/businesses', '/data-safety', '/no-inbox'],
  '/message': ['/message', '/templates', '/deliverability', '/operations'],
  '/replies': ['/replies'],
  '/settings': ['/settings'],
  '/challenges': ['/challenges'],
  '/help': ['/help']
};

function isActive(pathname: string, href: string) {
  const routes = groupedRoutes[href] || [href];
  return routes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Main navigation">
      {items.map((item) => {
        const Icon = item.icon;
        const active = isActive(pathname, item.href);
        return (
          <Link key={item.href} href={item.href} className={active ? 'active' : ''}>
            <Icon size={18} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
