import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { HttpError } from './errors.js';
import { extractBearerToken, JwtError, type AccessTokenVerifier } from './jwt-verify.js';

export type Principal =
  | { kind: 'executive'; userId: string; holdingCompanyId: string }
  | { kind: 'internal' }
  | { kind: 'dev' };

export interface AuthConfig {
  /** AUTH_DISABLED=true — development only. */
  disabled: boolean;
  verifier?: AccessTokenVerifier;
  /** INTERNAL_API_TOKEN: accepted as `x-internal-token` or as a bearer token. */
  internalToken?: string;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Authenticator {
  constructor(private readonly config: AuthConfig) {}

  private internal(req: FastifyRequest): boolean {
    const secret = this.config.internalToken;
    if (!secret) return false;
    const header = req.headers['x-internal-token'];
    const bearer = extractBearerToken(req.headers.authorization);
    return (
      (typeof header === 'string' && sameSecret(header, secret)) ||
      (bearer !== undefined && sameSecret(bearer, secret))
    );
  }

  /**
   * Group views (§2): only `group_executive` tokens whose `hc` claim matches the holding company,
   * or service-to-service calls with the internal token.
   */
  async groupReader(req: FastifyRequest, holdingCompanyId: string): Promise<Principal> {
    if (this.config.disabled) return { kind: 'dev' };
    if (this.internal(req)) return { kind: 'internal' };
    const token = extractBearerToken(req.headers.authorization);
    if (!token) throw new HttpError(401, 'unauthorized', 'Bearer token required');
    if (!this.config.verifier)
      throw new HttpError(401, 'invalid_token', 'Token verification is not configured');
    let claims;
    try {
      claims = await this.config.verifier(token);
    } catch (err) {
      const code =
        err instanceof JwtError && err.code === 'expired' ? 'token_expired' : 'invalid_token';
      throw new HttpError(401, code, 'Invalid or expired access token');
    }
    if (claims.role !== 'group_executive')
      throw new HttpError(403, 'forbidden', 'Group executive role required');
    if (claims.hc !== holdingCompanyId)
      throw new HttpError(403, 'forbidden', 'Access to another holding company is not allowed');
    return { kind: 'executive', userId: claims.sub, holdingCompanyId };
  }

  /** Pipeline and scheduler endpoints: internal token only (or dev mode). */
  operator(req: FastifyRequest): Principal {
    if (this.config.disabled) return { kind: 'dev' };
    if (this.internal(req)) return { kind: 'internal' };
    throw new HttpError(401, 'unauthorized', 'Internal token required');
  }
}

export const actorIdOf = (p: Principal): string | null =>
  p.kind === 'executive' ? p.userId : null;
