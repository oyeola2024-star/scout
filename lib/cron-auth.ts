import type { NextRequest } from 'next/server';

export function cronSecretFromRequest(request: NextRequest, body?: Record<string, unknown>) {
  const authorization = request.headers.get('authorization') || '';
  const bearer = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
  return String(
    body?.token ||
    request.headers.get('x-cron-secret') ||
    request.headers.get('x-schedule-worker-secret') ||
    request.nextUrl.searchParams.get('token') ||
    bearer ||
    '',
  );
}

export function isCronAuthorized(request: NextRequest, body?: Record<string, unknown>) {
  const expected = process.env.CRON_SECRET || process.env.SCHEDULE_WORKER_SECRET || '';
  if (!expected) return false;
  const provided = cronSecretFromRequest(request, body);
  return provided.length >= 24 && provided === expected;
}
