import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJwksAccessTokenVerifier, decodeJwt } from './jwt-verify.js';
import { bearer, injectFetch, login, PASSWORD, setup, type TestContext } from './test/helpers.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
});

const b64 = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('login', () => {
  it('issues an EdDSA access token with the contract claims and a refresh token', async () => {
    const res = await login(ctx, ctx.users.student);
    expect(res.expiresIn).toBe(900);
    expect(res.refreshToken).toMatch(/^rt_/);
    expect(res.user).toMatchObject({ id: ctx.users.student.id, role: 'student' });

    const { header, payload } = decodeJwt(res.accessToken);
    expect(header).toMatchObject({ alg: 'EdDSA', typ: 'JWT', kid: ctx.deps.keyStore.active.kid });
    expect(payload).toMatchObject({
      iss: 'ci-identity',
      aud: 'ci',
      sub: ctx.users.student.id,
      inst: ctx.users.student.institutionId,
      role: 'student',
      pid: ctx.users.student.studentId,
    });
    expect(Number(payload['exp']) - Number(payload['iat'])).toBe(900);
    expect(ctx.audit.events.at(-1)).toMatchObject({
      action: 'auth.login_succeeded',
      actorId: ctx.users.student.id,
    });
  });

  it('the token verifies through the public JWKS endpoint', async () => {
    const { accessToken } = await login(ctx, ctx.users.professor);
    const jwks = await ctx.app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(jwks.json<{ keys: Array<Record<string, string>> }>().keys[0]).toMatchObject({
      kty: 'OKP',
      crv: 'Ed25519',
      alg: 'EdDSA',
      use: 'sig',
      kid: ctx.deps.keyStore.active.kid,
    });
    const verify = createJwksAccessTokenVerifier({
      jwksUrl: 'http://identity.local/.well-known/jwks.json',
      fetch: injectFetch(ctx.app),
      now: () => ctx.clock.now(),
    });
    await expect(verify(accessToken)).resolves.toMatchObject({
      role: 'professor',
      pid: ctx.users.professor.professorId,
    });
  });

  it('rejects a wrong password and an unknown user with the same generic error', async () => {
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: ctx.users.student.email,
        password: 'nope',
        institutionId: ctx.users.student.institutionId,
      },
    });
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'ghost@example.edu.br',
        password: 'nope',
        institutionId: ctx.users.student.institutionId,
      },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.json()).toEqual({
      error: { code: 'invalid_credentials', message: 'Invalid email or password' },
    });
    expect(ctx.audit.events.filter((e) => e.action === 'auth.login_failed')).toHaveLength(2);
  });

  it('does not let a user of one institution log in through another institution', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: ctx.users.adminB.email,
        password: PASSWORD,
        institutionId: ctx.users.admin.institutionId,
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('locks the account for 15 minutes after 5 failures, even for the right password', async () => {
    const attempt = (password: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: ctx.users.student.email,
          password,
          institutionId: ctx.users.student.institutionId,
        },
      });
    for (let i = 0; i < 5; i += 1) expect((await attempt('wrong-password')).statusCode).toBe(401);
    expect(ctx.audit.events.filter((e) => e.action === 'auth.locked')).toHaveLength(1);

    const locked = await attempt(PASSWORD);
    expect(locked.statusCode).toBe(423);
    expect(locked.json<{ error: { code: string } }>().error.code).toBe('account_locked');
    expect(locked.headers['retry-after']).toBe('900');

    ctx.clock.advance(14 * 60_000);
    expect((await attempt(PASSWORD)).statusCode).toBe(423);
    ctx.clock.advance(61_000);
    expect((await attempt(PASSWORD)).statusCode).toBe(200);
  });

  it('a successful login resets the failure counter', async () => {
    const attempt = (password: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: ctx.users.student.email,
          password,
          institutionId: ctx.users.student.institutionId,
        },
      });
    for (let i = 0; i < 4; i += 1) await attempt('wrong-password');
    expect((await attempt(PASSWORD)).statusCode).toBe(200);
    for (let i = 0; i < 4; i += 1) await attempt('wrong-password');
    expect((await attempt(PASSWORD)).statusCode).toBe(200);
  });

  it('validates the request body', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_error');
  });
});

describe('access token validation', () => {
  it('serves /v1/me for a valid token', async () => {
    const { accessToken } = await login(ctx, ctx.users.student);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: ctx.users.student.id, email: ctx.users.student.email });
  });

  it('rejects requests without a token', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an expired token', async () => {
    const { accessToken } = await login(ctx, ctx.users.student);
    ctx.clock.advance(15 * 60_000 + 1_000);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('token_expired');
  });

  it('rejects a tampered payload (privilege escalation attempt)', async () => {
    const { accessToken } = await login(ctx, ctx.users.student);
    const [h, p, s] = accessToken.split('.') as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
    const forged = `${h}.${b64({ ...payload, role: 'admin' })}.${s}`;
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(forged) });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('invalid_token');
  });

  it('rejects alg "none" tokens', async () => {
    const { accessToken } = await login(ctx, ctx.users.student);
    const payload = decodeJwt(accessToken).payload;
    for (const token of [
      `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`,
      `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.c2ln`,
    ]) {
      const res = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
      expect(res.statusCode).toBe(401);
    }
  });

  it('rejects HS256 tokens signed with the public key as the HMAC secret (alg confusion)', async () => {
    const { accessToken } = await login(ctx, ctx.users.student);
    const payload = { ...decodeJwt(accessToken).payload, role: 'admin' };
    const jwk = ctx.deps.keyStore.jwks().keys[0];
    const pem = ctx.deps.keyStore.active.publicKey.export({ format: 'pem', type: 'spki' });
    for (const secret of [String(jwk?.x), String(pem)]) {
      const input = `${b64({ alg: 'HS256', typ: 'JWT', kid: ctx.deps.keyStore.active.kid })}.${b64(payload)}`;
      const sig = createHmac('sha256', secret).update(input).digest('base64url');
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: bearer(`${input}.${sig}`),
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('rejects tokens from another signing key with the same kid', async () => {
    const other = await setup();
    const { accessToken } = await login(other, other.users.student);
    const [, p, s] = accessToken.split('.') as [string, string, string];
    const spoofed = `${b64({ alg: 'EdDSA', typ: 'JWT', kid: ctx.deps.keyStore.active.kid })}.${p}.${s}`;
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(spoofed) });
    expect(res.statusCode).toBe(401);
    await other.app.close();
  });
});

describe('refresh tokens', () => {
  it('rotates refresh tokens on every use', async () => {
    const first = await login(ctx, ctx.users.student);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });
    expect(res.statusCode).toBe(200);
    const second = res.json<{ accessToken: string; refreshToken: string }>();
    expect(second.refreshToken).not.toBe(first.refreshToken);
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(second.accessToken),
    });
    expect(me.statusCode).toBe(200);
  });

  it('reuse of a rotated token revokes the whole family', async () => {
    const first = await login(ctx, ctx.users.student);
    const rotated = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });
    const second = rotated.json<{ refreshToken: string }>();

    const reuse = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    expect(ctx.audit.events.at(-1)).toMatchObject({
      action: 'auth.refresh_reuse_detected',
      actorId: ctx.users.student.id,
    });

    const afterRevocation = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: second.refreshToken },
    });
    expect(afterRevocation.statusCode).toBe(401);
  });

  it('expired refresh tokens are rejected', async () => {
    const first = await login(ctx, ctx.users.student);
    ctx.clock.advance(30 * 24 * 60 * 60_000 + 1);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refresh tokens stop working when the user is disabled', async () => {
    const first = await login(ctx, ctx.users.student);
    await ctx.deps.repos.users.update({ ...ctx.users.student, status: 'disabled' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });
    expect(res.statusCode).toBe(401);
  });

  it('logout revokes the refresh family and the presented access token', async () => {
    const session = await login(ctx, ctx.users.student);
    const out = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: bearer(session.accessToken),
      payload: { refreshToken: session.refreshToken },
    });
    expect(out.statusCode).toBe(204);
    const refresh = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(session.accessToken),
    });
    expect(me.statusCode).toBe(401);
    expect(me.json<{ error: { code: string } }>().error.code).toBe('token_revoked');
  });

  it('refresh token values are never stored in plain text', async () => {
    const session = await login(ctx, ctx.users.student);
    const { hashToken } = await import('./tokens.js');
    const record = await ctx.deps.repos.refreshTokens.findByHash(hashToken(session.refreshToken));
    expect(record).toBeDefined();
    expect(JSON.stringify(record)).not.toContain(session.refreshToken);
  });
});
