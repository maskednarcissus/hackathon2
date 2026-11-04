import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { COOKIE_SECURE, SESSION_COOKIES } from './config';
import { decodeAccessToken, type AccessClaims } from './jwt';

export interface Session {
  accessToken: string;
  claims: AccessClaims;
  /** Shortcuts derived from the token claims. */
  userId: string;
  studentId: string;
  institutionId: string;
}

const REFRESH_MAX_AGE_S = 30 * 24 * 60 * 60;

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const accessToken = jar.get(SESSION_COOKIES.access)?.value;
  if (accessToken === undefined) return null;
  const claims = decodeAccessToken(accessToken);
  if (claims === null) return null;
  return {
    accessToken,
    claims,
    userId: claims.sub,
    studentId: claims.pid,
    institutionId: claims.inst,
  };
}

/** Use in pages/actions that need an authenticated student. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (session === null) redirect('/entrar');
  return session;
}

export const cookieOptions = (maxAgeSeconds: number) =>
  ({
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  }) as const;

/** Only callable from Server Actions / Route Handlers. */
export async function setSessionCookies(tokens: {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIES.access, tokens.accessToken, cookieOptions(tokens.expiresIn));
  jar.set(SESSION_COOKIES.refresh, tokens.refreshToken, cookieOptions(REFRESH_MAX_AGE_S));
}

export async function getRefreshToken(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIES.refresh)?.value;
}

export async function clearSessionCookies(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIES.access);
  jar.delete(SESSION_COOKIES.refresh);
}

export { REFRESH_MAX_AGE_S };
