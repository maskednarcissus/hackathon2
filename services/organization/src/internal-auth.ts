import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { unauthorized } from './errors.js';

export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

/** Constant-time comparison (hashing first makes lengths equal). */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Integration stage §4: when `INTERNAL_API_TOKEN` is configured, service-to-service routes require
 * `x-internal-token`; unset → open (development only).
 */
export function createInternalGuard(
  token: string | undefined,
): (request: FastifyRequest) => Promise<void> {
  return (request) => {
    if (!token) return Promise.resolve();
    if (!tokenMatches(headerValue(request, INTERNAL_TOKEN_HEADER), token)) {
      return Promise.reject(
        unauthorized('internal_auth_required', 'Valid x-internal-token header required'),
      );
    }
    return Promise.resolve();
  };
}
