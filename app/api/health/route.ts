import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function has(name: string) {
  return Boolean(process.env[name] && String(process.env[name]).trim());
}

export async function GET() {
  const checks = {
    success: true,
    app: 'ok',
    version: '10.36.0',
    supabaseUrl: has('NEXT_PUBLIC_SUPABASE_URL'),
    supabaseAnon: has('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    supabaseServerSecret: has('SUPABASE_SECRET_KEY') || has('SUPABASE_SERVICE_ROLE_KEY'),
    googleClientId: has('NEXT_PUBLIC_GOOGLE_CLIENT_ID') || has('GOOGLE_CLIENT_ID'),
    googleClientSecret: has('GOOGLE_CLIENT_SECRET'),
    supabaseCronConfigured: has('SCHEDULE_WORKER_SECRET') && has('CRON_SECRET'),
    defaultWorkspaceId: process.env.SCOUT_DEFAULT_WORKSPACE_ID || '00000000-0000-4000-8000-000000000001'
  };

  return NextResponse.json(checks);
}
