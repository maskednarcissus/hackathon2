import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { HttpError } from './errors.js';
import { extractBearerToken, JwtError, type AccessTokenVerifier, type Role } from './jwt-verify.js';

export type Principal =
  | { kind: 'user'; userId: string; role: Role; institutionId: string }
  | { kind: 'internal' }
  | { kind: 'dev' };

export interface AuthConfig {
  /** AUTH_DISABLED=true — development only: every request is treated as an admin of any institution. */
  disabled: boolean;
  verifier?: AccessTokenVerifier;
  /** Shared secret for service-to-service calls (sync feeds, nightly snapshot job). */
  internalToken?: string;
}

const ANALYTICS_ROLES: readonly Role[] = ['coordinator', 'admin'];

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Authenticator {
  constructor(private readonly config: AuthConfig) {}

  async principal(req: FastifyRequest): Promise<Principal> {
    if (this.config.disabled) return { kind: 'dev' };
    const token = extractBearerToken(req.headers.authorization);
    if (!token) throw new HttpError(401, 'unauthorized', 'Bearer token required');
    if (this.config.internalToken && sameSecret(token, this.config.internalToken))
      return { kind: 'internal' };
    if (!this.config.verifier)
      throw new HttpError(401, 'invalid_token', 'Token verification is not configured');
    try {
      const claims = await this.config.verifier(token);
      return { kind: 'user', userId: claims.sub, role: claims.role, institutionId: claims.inst };
    } catch (err) {
      const code =
        err instanceof JwtError && err.code === 'expired' ? 'token_expired' : 'invalid_token';
      throw new HttpError(401, code, 'Invalid or expired access token');
    }
  }

  /** Coordinators and admins of `institutionId` (analytics never crosses institutions). */
  async analyticsReader(req: FastifyRequest, institutionId: string): Promise<Principal> {
    const p = await this.principal(req);
    if (p.kind === 'user') {
      if (!ANALYTICS_ROLES.includes(p.role))
        throw new HttpError(403, 'forbidden', 'Coordinator or admin role required');
      if (p.institutionId !== institutionId)
        throw new HttpError(403, 'forbidden', 'Access to another institution is not allowed');
    }
    return p;
  }

  /** Writers of institution configuration (syllabus): coordinators and admins of the institution. */
  analyticsWriter(req: FastifyRequest, institutionId: string): Promise<Principal> {
    return this.analyticsReader(req, institutionId);
  }

  /** Data feeds and jobs: the internal token, or an admin of every institution touched. */
  async operator(req: FastifyRequest, institutionIds: readonly string[]): Promise<Principal> {
    const p = await this.principal(req);
    if (p.kind === 'user') {
      if (p.role !== 'admin')
        throw new HttpError(403, 'forbidden', 'Admin role or internal token required');
      if (institutionIds.some((id) => id !== p.institutionId)) {
        throw new HttpError(403, 'forbidden', 'Access to another institution is not allowed');
      }
    }
    return p;
  }
}

export const actorIdOf = (p: Principal): string | null => (p.kind === 'user' ? p.userId : null);
