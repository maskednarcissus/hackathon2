import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createJwksKeyResolver, JwtError, verifyJwt, type KeyResolver } from './jwt-verify.js';
import type {
  OidcConfigRepository,
  OidcProviderConfig,
  OidcStateRepository,
} from './repositories.js';
import type { Clock } from './tokens.js';

/** Identity asserted by an external IdP after a successful authorization-code flow. */
export interface ExternalIdentity {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean | undefined;
  name: string | undefined;
}

export class IdentityProviderError extends Error {
  constructor(
    public readonly code:
      | 'invalid_state'
      | 'state_expired'
      | 'token_exchange_failed'
      | 'invalid_id_token'
      | 'email_missing'
      | 'email_not_verified',
    message: string,
  ) {
    super(message);
    this.name = 'IdentityProviderError';
  }
}

/** Pluggable external identity provider (OIDC today, SAML later). */
export interface IdentityProvider {
  readonly kind: 'oidc';
  readonly institutionId: string;
  startAuthorization(): Promise<{ authorizationUrl: string; state: string }>;
  completeAuthorization(input: { code: string; state: string }): Promise<ExternalIdentity>;
}

export interface IdentityProviderRegistry {
  forInstitution(institutionId: string): Promise<IdentityProvider | undefined>;
}

export interface OidcDeps {
  states: OidcStateRepository;
  clock: Clock;
  fetch: typeof fetch;
  /** Optional shared key resolver cache keyed by JWKS URI. */
  keyResolverFor?: (jwksUri: string) => KeyResolver;
  stateTtlSeconds?: number;
  clockSkewSeconds?: number;
}

const TokenResponseSchema = z.object({
  id_token: z.string().min(1),
  access_token: z.string().optional(),
  token_type: z.string().optional(),
});

const IdTokenClaimsSchema = z.object({
  iss: z.string(),
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number(),
  nonce: z.string().optional(),
  azp: z.string().optional(),
  email: z.string().email().optional(),
  email_verified: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  name: z.string().optional(),
});

const b64url = (buf: Buffer): string => buf.toString('base64url');

export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

export class OidcIdentityProvider implements IdentityProvider {
  readonly kind = 'oidc' as const;
  private readonly keyResolver: KeyResolver;

  constructor(
    private readonly config: OidcProviderConfig,
    private readonly deps: OidcDeps,
  ) {
    this.keyResolver =
      deps.keyResolverFor?.(config.jwksUri) ??
      createJwksKeyResolver({
        jwksUrl: config.jwksUri,
        fetch: deps.fetch,
        now: () => deps.clock.now(),
      });
  }

  get institutionId(): string {
    return this.config.institutionId;
  }

  async startAuthorization(): Promise<{ authorizationUrl: string; state: string }> {
    const state = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(32));
    const codeVerifier = b64url(randomBytes(48));
    const now = this.deps.clock.now();
    await this.deps.states.save({
      state,
      institutionId: this.config.institutionId,
      codeVerifier,
      nonce,
      createdAt: now,
      expiresAt: new Date(now.getTime() + (this.deps.stateTtlSeconds ?? 600) * 1000),
    });
    const url = new URL(this.config.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', this.config.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', pkceChallenge(codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    return { authorizationUrl: url.toString(), state };
  }

  async completeAuthorization(input: { code: string; state: string }): Promise<ExternalIdentity> {
    const stored = await this.deps.states.consume(input.state);
    if (!stored || stored.institutionId !== this.config.institutionId) {
      throw new IdentityProviderError('invalid_state', 'Unknown or already used state');
    }
    if (stored.expiresAt.getTime() <= this.deps.clock.now().getTime()) {
      throw new IdentityProviderError('state_expired', 'Authorization request expired');
    }

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: stored.codeVerifier,
    });
    if (this.config.clientSecret) form.set('client_secret', this.config.clientSecret);

    let idToken: string;
    try {
      const response = await this.deps.fetch(this.config.tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: form.toString(),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      idToken = TokenResponseSchema.parse(await response.json()).id_token;
    } catch (err) {
      throw new IdentityProviderError(
        'token_exchange_failed',
        `Token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let claims: z.infer<typeof IdTokenClaimsSchema>;
    try {
      const payload = await verifyJwt(idToken, {
        allowedAlgorithms: ['RS256'],
        getKey: this.keyResolver,
        issuer: this.config.issuer,
        audience: this.config.clientId,
        now: () => this.deps.clock.now(),
        leewaySeconds: this.deps.clockSkewSeconds ?? 60,
      });
      claims = IdTokenClaimsSchema.parse(payload);
    } catch (err) {
      const detail = err instanceof JwtError ? err.code : 'invalid_claims';
      throw new IdentityProviderError('invalid_id_token', `id_token rejected: ${detail}`);
    }
    if (claims.nonce !== stored.nonce) {
      throw new IdentityProviderError('invalid_id_token', 'id_token rejected: nonce mismatch');
    }
    if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== this.config.clientId) {
      throw new IdentityProviderError('invalid_id_token', 'id_token rejected: azp mismatch');
    }
    if (!claims.email)
      throw new IdentityProviderError('email_missing', 'id_token has no email claim');
    const emailVerified =
      claims.email_verified === undefined
        ? undefined
        : claims.email_verified === true || claims.email_verified === 'true';
    if (emailVerified === false) {
      throw new IdentityProviderError(
        'email_not_verified',
        'Email address is not verified by the IdP',
      );
    }
    return {
      issuer: claims.iss,
      subject: claims.sub,
      email: claims.email.toLowerCase(),
      emailVerified,
      name: claims.name,
    };
  }
}

export function createOidcProviderRegistry(
  configs: OidcConfigRepository,
  deps: OidcDeps,
): IdentityProviderRegistry {
  const resolvers = new Map<string, KeyResolver>();
  const keyResolverFor =
    deps.keyResolverFor ??
    ((jwksUri: string): KeyResolver => {
      let resolver = resolvers.get(jwksUri);
      if (!resolver) {
        resolver = createJwksKeyResolver({
          jwksUrl: jwksUri,
          fetch: deps.fetch,
          now: () => deps.clock.now(),
        });
        resolvers.set(jwksUri, resolver);
      }
      return resolver;
    });
  return {
    async forInstitution(institutionId: string): Promise<IdentityProvider | undefined> {
      const config = await configs.get(institutionId);
      return config ? new OidcIdentityProvider(config, { ...deps, keyResolverFor }) : undefined;
    },
  };
}
