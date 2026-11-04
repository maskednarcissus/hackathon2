/**
 * Decodes (does NOT verify) an access-token payload. Signature verification is done by every
 * upstream service against the identity JWKS; the BFF only needs the claims for routing/UI.
 * Works in both the Node.js and Edge runtimes.
 */
export interface AccessClaims {
  sub: string;
  inst: string;
  role: 'student' | 'professor' | 'coordinator' | 'admin';
  pid: string;
  exp: number;
  iat?: number;
}

function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function decodeAccessToken(token: string): AccessClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as Partial<AccessClaims>;
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.exp !== 'number' ||
      typeof payload.inst !== 'string' ||
      typeof payload.pid !== 'string' ||
      typeof payload.role !== 'string'
    ) {
      return null;
    }
    return payload as AccessClaims;
  } catch {
    return null;
  }
}

/** True when the token expires within `skewSeconds`. */
export function isExpiring(claims: AccessClaims, nowMs: number, skewSeconds = 30): boolean {
  return claims.exp * 1000 - nowMs <= skewSeconds * 1000;
}
