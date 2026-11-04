import { NextResponse, type NextRequest } from 'next/server';
import { decodeAccessToken, isExpiring } from './lib/jwt';

const ACCESS = 'ci_at';
const REFRESH = 'ci_rt';
const REFRESH_MAX_AGE_S = 30 * 24 * 60 * 60;
const IDENTITY_URL = (process.env['IDENTITY_URL'] ?? 'http://localhost:4001').replace(/\/$/, '');
const SECURE = process.env['COOKIE_INSECURE'] !== '1';

const PUBLIC_PATHS = ['/entrar'];

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

async function refresh(refreshToken: string): Promise<RefreshResponse | null> {
  try {
    const res = await fetch(`${IDENTITY_URL}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as RefreshResponse;
  } catch {
    return null;
  }
}

function toLogin(request: NextRequest): NextResponse {
  const url = request.nextUrl.clone();
  const next = request.nextUrl.pathname + request.nextUrl.search;
  url.pathname = '/entrar';
  url.search = next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
  const response = NextResponse.redirect(url);
  response.cookies.delete(ACCESS);
  return response;
}

/**
 * Session gate + silent token refresh. Refresh tokens rotate on every use, so the rotated pair is
 * written both to the response (browser) and to the forwarded request (this render).
 * Prefetches never trigger a refresh, to avoid concurrent use of the same refresh token.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const access = request.cookies.get(ACCESS)?.value;
  const claims = access !== undefined ? decodeAccessToken(access) : null;
  if (claims !== null && !isExpiring(claims, Date.now())) return NextResponse.next();

  const isPrefetch =
    request.headers.get('next-router-prefetch') !== null ||
    request.headers.get('purpose') === 'prefetch';
  const refreshToken = request.cookies.get(REFRESH)?.value;
  if (refreshToken === undefined) return toLogin(request);
  if (isPrefetch) {
    return claims !== null ? NextResponse.next() : new NextResponse(null, { status: 204 });
  }

  const tokens = await refresh(refreshToken);
  if (tokens === null) {
    const response = toLogin(request);
    response.cookies.delete(REFRESH);
    return response;
  }

  request.cookies.set(ACCESS, tokens.accessToken);
  request.cookies.set(REFRESH, tokens.refreshToken);
  const response = NextResponse.next({ request: { headers: request.headers } });
  const base = { httpOnly: true, secure: SECURE, sameSite: 'lax' as const, path: '/' };
  response.cookies.set(ACCESS, tokens.accessToken, { ...base, maxAge: tokens.expiresIn });
  response.cookies.set(REFRESH, tokens.refreshToken, { ...base, maxAge: REFRESH_MAX_AGE_S });
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|icon.svg).*)'],
};
