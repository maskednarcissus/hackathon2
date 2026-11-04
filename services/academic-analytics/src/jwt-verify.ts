/**
 * Reusable JWT verification for Classroom Intelligence services.
 *
 * Self-contained (node:crypto + zod + fastify types only) so other services can import or vendor it:
 *   const verify = createJwksAccessTokenVerifier({ jwksUrl: 'http://identity:4001/.well-known/jwks.json' });
 *   app.get('/v1/things', { preHandler: requireAuth(verify, { roles: ['student'] }) }, handler);
 *
 * Security properties:
 *  - the accepted algorithm list is fixed by the verifier, never taken from the token (`alg: none`,
 *    HS256 and any other algorithm are rejected before key lookup);
 *  - the key type must match the algorithm (EdDSA → Ed25519, RS256 → RSA), preventing key confusion;
 *  - `exp` is mandatory; `iss` and `aud` are enforced when configured.
 */
import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

export type JwtAlgorithm = 'EdDSA' | 'RS256';

export type JwtErrorCode =
  | 'malformed'
  | 'unsupported_alg'
  | 'unknown_kid'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'bad_issuer'
  | 'bad_audience'
  | 'bad_claims';

export class JwtError extends Error {
  constructor(
    public readonly code: JwtErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'JwtError';
  }
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function decodeSegment(segment: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment))
    throw new JwtError('malformed', 'Invalid base64url segment');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('malformed', 'Segment is not valid JSON');
  }
  if (!isRecord(parsed)) throw new JwtError('malformed', 'Segment is not a JSON object');
  return parsed;
}

export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed', 'Token must have three segments');
  const [h, p, s] = parts as [string, string, string];
  if (s.length === 0 || !/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new JwtError('malformed', 'Missing or invalid signature');
  }
  return {
    header: decodeSegment(h),
    payload: decodeSegment(p),
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s, 'base64url'),
  };
}

const KEY_TYPE_FOR_ALG: Record<JwtAlgorithm, string> = { EdDSA: 'ed25519', RS256: 'rsa' };

export function verifySignature(decoded: DecodedJwt, alg: JwtAlgorithm, key: KeyObject): boolean {
  if (key.type !== 'public' || key.asymmetricKeyType !== KEY_TYPE_FOR_ALG[alg]) {
    throw new JwtError('unsupported_alg', `Key type does not match algorithm ${alg}`);
  }
  const data = Buffer.from(decoded.signingInput, 'utf8');
  return alg === 'EdDSA'
    ? cryptoVerify(null, data, key, decoded.signature)
    : cryptoVerify('sha256', data, key, decoded.signature);
}

export type KeyResolver = (
  kid: string | undefined,
  alg: JwtAlgorithm,
) => Promise<KeyObject | undefined> | KeyObject | undefined;

export interface VerifyJwtOptions {
  allowedAlgorithms: readonly JwtAlgorithm[];
  getKey: KeyResolver;
  issuer?: string;
  audience?: string;
  now?: () => Date;
  leewaySeconds?: number;
}

/** Verifies signature and registered claims; returns the payload. Throws JwtError. */
export async function verifyJwt(
  token: string,
  options: VerifyJwtOptions,
): Promise<Record<string, unknown>> {
  const decoded = decodeJwt(token);
  const alg = decoded.header['alg'];
  if (typeof alg !== 'string' || !(options.allowedAlgorithms as readonly string[]).includes(alg)) {
    throw new JwtError('unsupported_alg', `Algorithm ${String(alg)} is not accepted`);
  }
  const kidValue = decoded.header['kid'];
  const kid = typeof kidValue === 'string' ? kidValue : undefined;
  const key = await options.getKey(kid, alg as JwtAlgorithm);
  if (!key) throw new JwtError('unknown_kid', `No verification key for kid ${String(kid)}`);
  if (!verifySignature(decoded, alg as JwtAlgorithm, key)) {
    throw new JwtError('bad_signature', 'Signature verification failed');
  }

  const { payload } = decoded;
  const nowSeconds = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
  const leeway = options.leewaySeconds ?? 0;
  const exp = payload['exp'];
  if (typeof exp !== 'number') throw new JwtError('bad_claims', 'exp claim is required');
  if (nowSeconds > exp + leeway) throw new JwtError('expired', 'Token has expired');
  const nbf = payload['nbf'];
  if (typeof nbf === 'number' && nowSeconds + leeway < nbf) {
    throw new JwtError('not_yet_valid', 'Token is not yet valid');
  }
  if (options.issuer !== undefined && payload['iss'] !== options.issuer) {
    throw new JwtError('bad_issuer', 'Unexpected issuer');
  }
  if (options.audience !== undefined) {
    const aud = payload['aud'];
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(options.audience)) {
      throw new JwtError('bad_audience', 'Unexpected audience');
    }
  }
  return payload;
}

// ---------------------------------------------------------------------------
// JWKS
// ---------------------------------------------------------------------------

const JwkSchema = z
  .object({
    kty: z.string(),
    kid: z.string().optional(),
    alg: z.string().optional(),
    use: z.string().optional(),
    crv: z.string().optional(),
    x: z.string().optional(),
    n: z.string().optional(),
    e: z.string().optional(),
  })
  .passthrough();

const JwksSchema = z.object({ keys: z.array(JwkSchema) });

export type Jwk = z.infer<typeof JwkSchema>;

export interface JwksResolverOptions {
  jwksUrl: string;
  fetch?: typeof fetch;
  /** How long a fetched key set is trusted before refetching. Default 5 minutes. */
  cacheTtlMs?: number;
  /** Minimum gap between refetches triggered by an unknown kid. Default 30 seconds. */
  minRefreshIntervalMs?: number;
  now?: () => Date;
}

function jwkMatchesAlg(jwk: Jwk, alg: JwtAlgorithm): boolean {
  if (jwk.alg !== undefined && jwk.alg !== alg) return false;
  if (jwk.use !== undefined && jwk.use !== 'sig') return false;
  return alg === 'EdDSA' ? jwk.kty === 'OKP' && jwk.crv === 'Ed25519' : jwk.kty === 'RSA';
}

/** Key resolver backed by a remote JWKS document, with caching and unknown-kid refresh. */
export function createJwksKeyResolver(options: JwksResolverOptions): KeyResolver {
  const doFetch = options.fetch ?? globalThis.fetch;
  const ttl = options.cacheTtlMs ?? 5 * 60_000;
  const minGap = options.minRefreshIntervalMs ?? 30_000;
  const now = (): number => (options.now?.() ?? new Date()).getTime();
  let cached: { keys: Jwk[]; fetchedAt: number } | undefined;
  let inflight: Promise<Jwk[]> | undefined;

  const load = async (): Promise<Jwk[]> => {
    inflight ??= (async (): Promise<Jwk[]> => {
      try {
        const response = await doFetch(options.jwksUrl, {
          headers: { accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`JWKS fetch failed with HTTP ${response.status}`);
        const parsed = JwksSchema.parse(await response.json());
        cached = { keys: parsed.keys, fetchedAt: now() };
        return parsed.keys;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };

  const find = (keys: Jwk[], kid: string | undefined, alg: JwtAlgorithm): Jwk | undefined => {
    const candidates = keys.filter((k) => jwkMatchesAlg(k, alg));
    if (kid !== undefined) return candidates.find((k) => k.kid === kid);
    return candidates.length === 1 ? candidates[0] : undefined;
  };

  return async (kid, alg) => {
    let keys = cached && now() - cached.fetchedAt < ttl ? cached.keys : await load();
    let jwk = find(keys, kid, alg);
    if (!jwk && cached && now() - cached.fetchedAt >= minGap) {
      keys = await load();
      jwk = find(keys, kid, alg);
    }
    if (!jwk) return undefined;
    try {
      return createPublicKey({ key: jwk as unknown as JsonWebKey, format: 'jwk' });
    } catch {
      return undefined;
    }
  };
}

/** RFC 7638-style short key id derived from the SPKI DER encoding. */
export function keyIdFor(publicKey: KeyObject): string {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(der).digest('base64url').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

export const ROLES = ['student', 'professor', 'coordinator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const AccessTokenClaimsSchema = z.object({
  iss: z.string(),
  sub: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string(),
  inst: z.string(),
  role: z.enum(ROLES),
  pid: z.string().optional(),
});

export type AccessTokenClaims = z.infer<typeof AccessTokenClaimsSchema>;

export const DEFAULT_ISSUER = 'ci-identity';
export const DEFAULT_AUDIENCE = 'ci';

export interface AccessTokenVerifierOptions {
  getKey: KeyResolver;
  issuer?: string;
  audience?: string;
  now?: () => Date;
  leewaySeconds?: number;
}

export type AccessTokenVerifier = (token: string) => Promise<AccessTokenClaims>;

export function createAccessTokenVerifier(
  options: AccessTokenVerifierOptions,
): AccessTokenVerifier {
  return async (token) => {
    const payload = await verifyJwt(token, {
      allowedAlgorithms: ['EdDSA'],
      getKey: options.getKey,
      issuer: options.issuer ?? DEFAULT_ISSUER,
      audience: options.audience ?? DEFAULT_AUDIENCE,
      ...(options.now ? { now: options.now } : {}),
      leewaySeconds: options.leewaySeconds ?? 0,
    });
    const parsed = AccessTokenClaimsSchema.safeParse(payload);
    if (!parsed.success) throw new JwtError('bad_claims', 'Access token claims are invalid');
    return parsed.data;
  };
}

export function createJwksAccessTokenVerifier(
  options: JwksResolverOptions & Omit<AccessTokenVerifierOptions, 'getKey'>,
): AccessTokenVerifier {
  return createAccessTokenVerifier({ ...options, getKey: createJwksKeyResolver(options) });
}

// ---------------------------------------------------------------------------
// Fastify preHandler
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AccessTokenClaims;
  }
}

export function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

export interface RequireAuthOptions {
  roles?: readonly Role[];
  /** Optional revocation check (e.g. a jti denylist). */
  isRevoked?: (claims: AccessTokenClaims) => Promise<boolean> | boolean;
}

export function requireAuth(verify: AccessTokenVerifier, options: RequireAuthOptions = {}) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> => {
    // Returning the reply from an async hook stops the request lifecycle (Fastify semantics).
    const deny = (status: number, code: string, message: string): FastifyReply =>
      reply.code(status).send({ error: { code, message } });
    const token = extractBearerToken(request.headers.authorization);
    if (!token) return deny(401, 'unauthorized', 'Bearer token required');
    let claims: AccessTokenClaims;
    try {
      claims = await verify(token);
    } catch (err) {
      const code =
        err instanceof JwtError && err.code === 'expired' ? 'token_expired' : 'invalid_token';
      return deny(401, code, 'Invalid or expired access token');
    }
    if (options.isRevoked && (await options.isRevoked(claims))) {
      return deny(401, 'token_revoked', 'Access token has been revoked');
    }
    if (options.roles && !options.roles.includes(claims.role)) {
      return deny(403, 'forbidden', 'Role not permitted for this resource');
    }
    request.auth = claims;
    return undefined;
  };
}
