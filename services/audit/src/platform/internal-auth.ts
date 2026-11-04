/**
 * Service-to-service authentication (integration-stage contract §4).
 * Vendored in every TS service — keep copies in sync.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Constant-time check of `x-internal-token`. Always true when no token is configured (dev). */
export function hasValidInternalToken(req: FastifyRequest, expected: string | undefined): boolean {
  if (!expected) return true;
  const given = req.headers['x-internal-token'];
  if (typeof given !== 'string' || given.length === 0) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

export class InternalAuthError extends Error {
  readonly statusCode = 401;
  readonly code = 'internal_token_required';
  constructor() {
    super('A valid x-internal-token header is required');
  }
}

/** Fastify preHandler factory for `/internal/*`, sync, event push and scheduler routes. */
export function requireInternalToken(expected: string | undefined) {
  return (req: FastifyRequest): Promise<void> =>
    hasValidInternalToken(req, expected)
      ? Promise.resolve()
      : Promise.reject(new InternalAuthError());
}
