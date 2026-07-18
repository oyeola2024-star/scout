'use client';

import { createClient } from '@/lib/supabase-browser';
import { useRouter } from 'next/navigation';

export function SignOutButton() {
  const router = useRouter();
  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace('/login');
    router.refresh();
  }
  return <button className="btn secondary" onClick={signOut}>Sign out</button>;
}
