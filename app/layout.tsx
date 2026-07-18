import './globals.css';
import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'Scout v10.38',
  description: 'Fresh-deploy Scout with Supabase authentication, team deduplication, adaptive Gmail safety limits, queued sending, replies, and free domain/MX checks.',
  manifest: '/manifest.json',
  appleWebApp: { capable: true, title: 'Scout', statusBarStyle: 'black-translucent' }
};

export const viewport: Viewport = {
  themeColor: '#111827'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
