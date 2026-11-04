import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOidcProviderRegistry, pkceChallenge } from './oidc.js';
import { createInMemoryRepositories } from './repositories.js';
import {
  createUser,
  INSTITUTION_A,
  MutableClock,
  setup,
  type TestContext,
} from './test/helpers.js';

const ISSUER = 'https://sso.universidade.example';
const CLIENT_ID = 'ci-client';

const b64 = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Minimal fake OIDC provider: token endpoint + JWKS, with PKCE verification. */
class FakeIdp {
  readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly kid = 'idp-key-1';
  readonly codes = new Map<string, { challenge: string; nonce: string; email: string }>();
  tokenRequests = 0;
  claimOverrides: Record<string, unknown> = {};
  headerOverrides: Record<string, unknown> = {};
  signWith: ((input: string) => string) | undefined;

  constructor(private readonly clock: MutableClock) {}

  issueCode(authorizationUrl: string, email: string): string {
    const url = new URL(authorizationUrl);
    const code = `code-${this.codes.size + 1}`;
    this.codes.set(code, {
      challenge: url.searchParams.get('code_challenge') ?? '',
      nonce: url.searchParams.get('nonce') ?? '',
      email,
    });
    return code;
  }

  idToken(claims: Record<string, unknown>, privateKey: KeyObject = this.keys.privateKey): string {
    const input = `${b64({ alg: 'RS256', typ: 'JWT', kid: this.kid, ...this.headerOverrides })}.${b64(claims)}`;
    const signature = this.signWith
      ? this.signWith(input)
      : sign('sha256', Buffer.from(input), privateKey).toString('base64url');
    return `${input}.${signature}`;
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/jwks`) {
      const jwk = this.keys.publicKey.export({ format: 'jwk' });
      return Response.json({ keys: [{ ...jwk, kid: this.kid, alg: 'RS256', use: 'sig' }] });
    }
    if (url === `${ISSUER}/token`) {
      this.tokenRequests += 1;
      const form = new URLSearchParams(String(init?.body));
      const entry = this.codes.get(form.get('code') ?? '');
      if (!entry || pkceChallenge(form.get('code_verifier') ?? '') !== entry.challenge) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      this.codes.delete(form.get('code') ?? '');
      const now = Math.floor(this.clock.now().getTime() / 1000);
      return Response.json({
        token_type: 'Bearer',
        access_token: 'idp-access',
        id_token: this.idToken({
          iss: ISSUER,
          sub: `sub-${entry.email}`,
          aud: CLIENT_ID,
          iat: now,
          exp: now + 300,
          nonce: entry.nonce,
          email: entry.email,
          email_verified: true,
          ...this.claimOverrides,
        }),
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

let ctx: TestContext;
let idp: FakeIdp;
let email: string;

beforeEach(async () => {
  const clock = new MutableClock();
  idp = new FakeIdp(clock);
  const repos = createInMemoryRepositories();
  ctx = await setup({
    clock,
    repos,
    identityProviders: createOidcProviderRegistry(repos.oidcConfigs, {
      states: repos.oidcStates,
      clock,
      fetch: idp.fetch,
    }),
  });
  const now = clock.now();
  await repos.oidcConfigs.save({
    institutionId: INSTITUTION_A,
    issuer: ISSUER,
    authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`,
    jwksUri: `${ISSUER}/jwks`,
    clientId: CLIENT_ID,
    clientSecret: 'shh',
    redirectUri: 'https://app.example/v1/auth/oidc/callback',
    scopes: ['openid', 'email'],
    createdAt: now,
    updatedAt: now,
  });
  email = ctx.users.student.email;
});
afterEach(async () => {
  await ctx.app.close();
});

async function start(): Promise<{ authorizationUrl: string; state: string }> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/v1/auth/oidc/${INSTITUTION_A}/start?format=json`,
  });
  expect(res.statusCode).toBe(200);
  const { authorizationUrl } = res.json<{ authorizationUrl: string }>();
  return { authorizationUrl, state: new URL(authorizationUrl).searchParams.get('state') ?? '' };
}

const callback = (code: string, state: string) =>
  ctx.app.inject({
    method: 'GET',
    url: `/v1/auth/oidc/${INSTITUTION_A}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  });

describe('OIDC authorization-code flow', () => {
  it('builds an authorization request with state, nonce and PKCE S256', async () => {
    const redirect = await ctx.app.inject({
      method: 'GET',
      url: `/v1/auth/oidc/${INSTITUTION_A}/start`,
    });
    expect(redirect.statusCode).toBe(302);
    const url = new URL(String(redirect.headers.location));
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('scope')).toBe('openid email');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')?.length).toBeGreaterThanOrEqual(32);
    expect(url.searchParams.get('nonce')?.length).toBeGreaterThanOrEqual(32);
  });

  it('logs in a provisioned user and links by email within the institution', async () => {
    const { authorizationUrl, state } = await start();
    const res = await callback(idp.issueCode(authorizationUrl, email.toUpperCase()), state);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ accessToken: string; user: { id: string } }>();
    expect(body.user.id).toBe(ctx.users.student.id);
    expect(ctx.audit.events.at(-1)).toMatchObject({
      action: 'auth.login_succeeded',
      metadata: { method: 'oidc' },
    });
  });

  it('state is single use', async () => {
    const { authorizationUrl, state } = await start();
    expect((await callback(idp.issueCode(authorizationUrl, email), state)).statusCode).toBe(200);
    const replay = await callback(idp.issueCode(authorizationUrl, email), state);
    expect(replay.statusCode).toBe(401);
    expect(replay.json<{ error: { code: string } }>().error.code).toBe('invalid_state');
  });

  it('rejects an expired state', async () => {
    const { authorizationUrl, state } = await start();
    ctx.clock.advance(11 * 60_000);
    const res = await callback(idp.issueCode(authorizationUrl, email), state);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('state_expired');
  });

  it('rejects a nonce mismatch', async () => {
    const { authorizationUrl, state } = await start();
    idp.claimOverrides = { nonce: 'attacker-nonce' };
    const res = await callback(idp.issueCode(authorizationUrl, email), state);
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_id_token');
  });

  it.each([
    ['wrong audience', { aud: 'someone-else' }],
    ['wrong issuer', { iss: 'https://evil.example' }],
    ['expired', { exp: 1 }],
    ['unverified email', { email_verified: false }],
  ])('rejects an id_token with %s', async (_label, overrides) => {
    const { authorizationUrl, state } = await start();
    idp.claimOverrides = overrides;
    const res = await callback(idp.issueCode(authorizationUrl, email), state);
    expect(res.statusCode).toBe(401);
  });

  it('rejects an id_token signed by another key', async () => {
    const { authorizationUrl, state } = await start();
    const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
    idp.signWith = (input) =>
      sign('sha256', Buffer.from(input), attacker.privateKey).toString('base64url');
    const res = await callback(idp.issueCode(authorizationUrl, email), state);
    expect(res.statusCode).toBe(401);
  });

  it('rejects HS256 id_tokens (alg confusion)', async () => {
    const { authorizationUrl, state } = await start();
    idp.headerOverrides = { alg: 'HS256' };
    idp.signWith = (input) => createHmac('sha256', 'shh').update(input).digest('base64url');
    const res = await callback(idp.issueCode(authorizationUrl, email), state);
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_id_token');
  });

  it('does not create accounts just-in-time', async () => {
    const { authorizationUrl, state } = await start();
    const res = await callback(
      idp.issueCode(authorizationUrl, 'nao-cadastrado@example.edu.br'),
      state,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('user_not_provisioned');
  });

  it('a user from another institution cannot be linked', async () => {
    const outsider = await createUser(ctx.deps, {
      institutionId: ctx.users.adminB.institutionId,
      role: 'student',
    });
    const { authorizationUrl, state } = await start();
    const res = await callback(idp.issueCode(authorizationUrl, outsider.email), state);
    expect(res.statusCode).toBe(403);
  });

  it('fails cleanly when the code exchange is refused', async () => {
    const { state } = await start();
    const res = await callback('forged-code', state);
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('token_exchange_failed');
  });

  it('returns 404 when SSO is not configured', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/auth/oidc/${ctx.users.adminB.institutionId}/start`,
    });
    expect(res.statusCode).toBe(404);
  });
});
