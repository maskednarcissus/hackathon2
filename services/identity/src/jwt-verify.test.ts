import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createJwksKeyResolver, requireAuth, type AccessTokenClaims } from './jwt-verify.js';
import { generateSigningKey, KeyStore } from './keys.js';
import { signAccessToken } from './tokens.js';

const claims = (overrides: Partial<AccessTokenClaims> = {}): AccessTokenClaims => {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'ci-identity',
    sub: 'user-1',
    aud: 'ci',
    iat: now,
    exp: now + 60,
    jti: 'jti-1',
    inst: 'inst-1',
    role: 'student',
    ...overrides,
  };
};

function jwksFetch(stores: { current: KeyStore }, counter: { calls: number }): typeof fetch {
  return (async () => {
    counter.calls += 1;
    return Response.json(stores.current.jwks());
  }) as typeof fetch;
}

describe('JWKS key resolver', () => {
  it('caches the key set and refetches once when an unknown kid appears (key rotation)', async () => {
    const first = new KeyStore(generateSigningKey());
    const stores = { current: first };
    const counter = { calls: 0 };
    let now = 0;
    const resolve = createJwksKeyResolver({
      jwksUrl: 'http://identity/.well-known/jwks.json',
      fetch: jwksFetch(stores, counter),
      now: () => new Date(now),
    });
    expect(await resolve(first.active.kid, 'EdDSA')).toBeDefined();
    expect(await resolve(first.active.kid, 'EdDSA')).toBeDefined();
    expect(counter.calls).toBe(1);

    const rotated = new KeyStore(generateSigningKey(), [first.active.publicKey]);
    stores.current = rotated;
    // Within the refresh rate limit the unknown kid is not refetched.
    expect(await resolve(rotated.active.kid, 'EdDSA')).toBeUndefined();
    now += 31_000;
    expect(await resolve(rotated.active.kid, 'EdDSA')).toBeDefined();
    expect(await resolve(first.active.kid, 'EdDSA')).toBeDefined();
    expect(counter.calls).toBe(2);
  });

  it('never resolves an Ed25519 key for RS256', async () => {
    const store = new KeyStore(generateSigningKey());
    const resolve = createJwksKeyResolver({
      jwksUrl: 'http://x',
      fetch: jwksFetch({ current: store }, { calls: 0 }),
    });
    expect(await resolve(store.active.kid, 'RS256')).toBeUndefined();
  });
});

describe('requireAuth preHandler', () => {
  const store = new KeyStore(generateSigningKey());
  const verify = async (token: string): Promise<AccessTokenClaims> => {
    const { createAccessTokenVerifier } = await import('./jwt-verify.js');
    return createAccessTokenVerifier({ getKey: (kid) => store.getPublicKey(kid) })(token);
  };

  const build = async () => {
    const app = Fastify();
    app.get('/any', { preHandler: requireAuth(verify) }, async (request) => ({
      sub: request.auth?.sub,
    }));
    app.get(
      '/staff',
      { preHandler: requireAuth(verify, { roles: ['admin', 'coordinator'] }) },
      async () => ({ ok: true }),
    );
    app.get(
      '/revocable',
      { preHandler: requireAuth(verify, { isRevoked: (c) => c.jti === 'jti-1' }) },
      async () => ({ ok: true }),
    );
    await app.ready();
    return app;
  };

  it('exposes claims to handlers and enforces roles and revocation', async () => {
    const app = await build();
    const student = signAccessToken(store, claims());
    const admin = signAccessToken(store, claims({ role: 'admin', jti: 'jti-2' }));
    const h = (t: string) => ({ authorization: `Bearer ${t}` });

    expect((await app.inject({ url: '/any', headers: h(student) })).json()).toEqual({
      sub: 'user-1',
    });
    expect((await app.inject({ url: '/any' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/staff', headers: h(student) })).statusCode).toBe(403);
    expect((await app.inject({ url: '/staff', headers: h(admin) })).statusCode).toBe(200);
    expect((await app.inject({ url: '/revocable', headers: h(student) })).statusCode).toBe(401);
    expect((await app.inject({ url: '/revocable', headers: h(admin) })).statusCode).toBe(200);
    await app.close();
  });

  it('rejects wrong audience, wrong issuer and missing exp', async () => {
    const app = await build();
    const h = (t: string) => ({ authorization: `Bearer ${t}` });
    for (const bad of [claims({ aud: 'other' }), claims({ iss: 'evil' })]) {
      expect(
        (await app.inject({ url: '/any', headers: h(signAccessToken(store, bad)) })).statusCode,
      ).toBe(401);
    }
    const noExp: Record<string, unknown> = { ...claims() };
    delete noExp['exp'];
    expect(
      (
        await app.inject({
          url: '/any',
          headers: h(signAccessToken(store, noExp as unknown as AccessTokenClaims)),
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
  });
});
