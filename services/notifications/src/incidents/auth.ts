import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { HttpError } from '../http.js';
import { extractBearerToken, type AccessTokenVerifier } from '../vendor/jwt-verify.js';

export interface AdminPrincipal {
  /** null = static ADMIN_API_TOKEN (service account, any institution). */
  institutionId: string | null;
  userId: string | null;
}

export interface AdminAuthOptions {
  /** Static bearer token (`ADMIN_API_TOKEN`). */
  adminToken?: string | undefined;
  /** Identity JWT verifier; role must be coordinator or admin (Phase 4 preamble). */
  verifyToken?: AccessTokenVerifier | undefined;
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Admin routes: open when neither option is configured (development), otherwise a bearer
 * token is required — the static admin token or a coordinator/admin identity JWT.
 */
export function createAdminAuth(options: AdminAuthOptions) {
  return async (req: FastifyRequest): Promise<AdminPrincipal> => {
    if (!options.adminToken && !options.verifyToken) return { institutionId: null, userId: null };
    const token = extractBearerToken(req.headers.authorization);
    if (!token) throw new HttpError(401, 'unauthorized', 'Bearer token required');
    if (options.adminToken && safeEqual(token, options.adminToken)) {
      return { institutionId: null, userId: null };
    }
    if (options.verifyToken) {
      try {
        const claims = await options.verifyToken(token);
        if (claims.role !== 'coordinator' && claims.role !== 'admin') {
          throw new HttpError(403, 'forbidden', 'Coordinator or admin role required');
        }
        return { institutionId: claims.inst, userId: claims.sub };
      } catch (err) {
        if (err instanceof HttpError) throw err;
      }
    }
    throw new HttpError(401, 'invalid_token', 'Invalid or expired access token');
  };
}

/** A JWT principal may only see its own institution. */
export function scopeInstitution(
  principal: AdminPrincipal,
  requested: string | undefined,
): string | undefined {
  if (principal.institutionId === null) return requested;
  if (requested && requested !== principal.institutionId) {
    throw new HttpError(403, 'forbidden', 'Institution outside the caller scope');
  }
  return principal.institutionId;
}
