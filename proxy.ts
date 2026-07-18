import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

const protectedPrefixes = ['/dashboard', '/upload', '/businesses', '/verify', '/source-scout', '/daily-scouting', '/auto-scout', '/email-scout', '/templates', '/message', '/replies', '/no-inbox', '/notifications', '/operations', '/deliverability', '/settings', '/team', '/data-safety'];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return response;

  try {
    const supabase = createServerClient(url, anon, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        }
      }
    });

    const { data: { user } } = await supabase.auth.getUser();
    const path = request.nextUrl.pathname;
    const isProtected = protectedPrefixes.some((prefix) => path.startsWith(prefix));

    if (isProtected && !user) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = '/login';
      loginUrl.searchParams.set('next', `${path}${request.nextUrl.search}`);
      return NextResponse.redirect(loginUrl);
    }

    if ((path === '/login' || path === '/') && user) {
      const dashboardUrl = request.nextUrl.clone();
      dashboardUrl.pathname = '/dashboard';
      dashboardUrl.search = '';
      return NextResponse.redirect(dashboardUrl);
    }

    return response;
  } catch (error) {
    // Do not turn a temporary Supabase/Auth outage into a site-wide middleware 500.
    // Protected server pages still validate the session before returning private data.
    console.error('Scout proxy auth check failed:', error);
    return response;
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)']
};
