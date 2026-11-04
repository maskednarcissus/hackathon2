/**
 * Behavioural scenarios against PostgreSQL (skipped unless TEST_DATABASE_URL is set).
 * Fresh database per file with every migration (V*.sql + pending/*.sql) applied.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import {
  InMemoryExportStore,
  type DataSubjectHandler,
  type DsrHandlerPayload,
  type DsrHandlerResult,
  type DsrType,
} from './dsr.js';
import { generateSigningKey } from './keys.js';
import { createPgRepositories, GraceCipher, PgDsrRepository } from './repository.pg.js';
import {
  bearer,
  INSTITUTION_A,
  INSTITUTION_B,
  INTERNAL_TOKEN,
  login,
  PASSWORD,
  setup,
  type TestContext,
} from './test/helpers.js';
import {
  createTestDatabase,
  insertPerson,
  seedInstitutions,
  TEST_DATABASE_URL,
  type TestDatabase,
} from './test/pg.js';

class FlakyHandler implements DataSubjectHandler {
  calls = 0;
  constructor(
    readonly name: string,
    private readonly failures: number,
  ) {}
  async handle(_type: DsrType, payload: DsrHandlerPayload): Promise<DsrHandlerResult> {
    this.calls += 1;
    if (this.calls <= this.failures) {
      return { service: this.name, status: 'failed', items: null, error: 'unavailable' };
    }
    return { service: this.name, status: 'completed', items: [{ subjectId: payload.subjectId }] };
  }
}

type Json = Record<string, unknown>;
type Pair = { accessToken: string; refreshToken: string };

describe.skipIf(!TEST_DATABASE_URL)('identity on PostgreSQL', () => {
  let db: TestDatabase;
  let ctx: TestContext;
  let notifications: FlakyHandler;
  const cipher = new GraceCipher(Buffer.alloc(32, 7));

  beforeAll(async () => {
    db = await createTestDatabase(TEST_DATABASE_URL ?? '');
    await seedInstitutions(db.pool, [INSTITUTION_A, INSTITUTION_B]);
  });
  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    notifications = new FlakyHandler('notifications', 1);
    ctx = await setup({
      repos: createPgRepositories(db.pool, { graceCipher: cipher }),
      dsr: {
        repo: new PgDsrRepository(db.pool),
        handlers: [notifications],
        exportStore: new InMemoryExportStore(),
      },
      personFactory: (institutionId, kind) => insertPerson(db.pool, institutionId, kind),
    });
  });

  const refresh = (refreshToken: string, app = ctx.app) =>
    app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken } });

  it('logs in, records login events and serves /v1/me', async () => {
    const session = await login(ctx, ctx.users.student);
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(session.accessToken),
    });
    expect(me.json<Json>()['id']).toBe(ctx.users.student.id);
    const events = await db.pool.query('SELECT outcome FROM login_events WHERE user_id = $1', [
      ctx.users.student.id,
    ]);
    expect(events.rows).toEqual([{ outcome: 'succeeded' }]);
  });

  it('persists the lockout across app instances', async () => {
    const attempt = (app = ctx.app) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: {
          email: ctx.users.student.email,
          password: 'wrong',
          institutionId: INSTITUTION_A,
        },
      });
    for (let i = 0; i < 5; i += 1) expect((await attempt()).statusCode).toBe(401);
    const other = await buildApp(ctx.deps);
    const locked = await other.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: ctx.users.student.email, password: PASSWORD, institutionId: INSTITUTION_A },
    });
    expect(locked.statusCode).toBe(423);
    await other.close();
  });

  it('enforces case-insensitive email uniqueness per institution', async () => {
    const admin = await login(ctx, ctx.users.admin);
    const body = {
      institutionId: INSTITUTION_A,
      email: ctx.users.coordinator.email.toUpperCase(),
      name: 'Duplicado',
      role: 'coordinator',
    };
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: bearer(admin.accessToken),
      payload: body,
    });
    expect(res.statusCode).toBe(409);
  });

  describe('refresh rotation', () => {
    it('rotates, then revokes the family on reuse after the grace window', async () => {
      const first = await login(ctx, ctx.users.student);
      const second = (await refresh(first.refreshToken)).json<Pair>();
      expect(second.refreshToken).not.toBe(first.refreshToken);
      ctx.clock.advance(10_001);
      expect((await refresh(first.refreshToken)).statusCode).toBe(401);
      expect((await refresh(second.refreshToken)).statusCode).toBe(401);
      expect(ctx.audit.events.at(-1)?.action).toBe('auth.refresh_reuse_detected');
    });

    it('replays the same successor within the grace window; the pair is encrypted at rest', async () => {
      const first = await login(ctx, ctx.users.student);
      const second = (await refresh(first.refreshToken)).json<Pair>();
      ctx.clock.advance(5_000);
      const replay = await refresh(first.refreshToken);
      expect(replay.statusCode).toBe(200);
      expect(replay.json<Pair>().refreshToken).toBe(second.refreshToken);

      const stored = await db.pool.query<{ payload: Buffer }>(
        'SELECT payload FROM refresh_token_grace g JOIN refresh_tokens t ON t.id = g.previous_token_id WHERE t.user_id = $1',
        [ctx.users.student.id],
      );
      expect(stored.rows).toHaveLength(1);
      const raw = stored.rows[0]?.payload.toString('latin1') ?? '';
      expect(raw).not.toContain(second.refreshToken);
      expect(raw).not.toContain(second.accessToken.slice(0, 40));
    });

    it('serialises concurrent refreshes from two replicas with a row lock (one rotation)', async () => {
      const first = await login(ctx, ctx.users.student);
      const replicaA = await buildApp(ctx.deps);
      const replicaB = await buildApp(ctx.deps);
      const [a, b] = await Promise.all([
        refresh(first.refreshToken, replicaA),
        refresh(first.refreshToken, replicaB),
      ]);
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      expect(a.json<Pair>().refreshToken).toBe(b.json<Pair>().refreshToken);
      const family = await db.pool.query(
        `SELECT count(*)::int AS n FROM refresh_tokens WHERE family_id =
           (SELECT family_id FROM refresh_tokens WHERE token_hash = encode(sha256($1::bytea), 'hex'))`,
        [Buffer.from(first.refreshToken)],
      );
      expect(family.rows[0]).toEqual({ n: 2 });
      expect((await refresh(a.json<Pair>().refreshToken, replicaA)).statusCode).toBe(200);
      await replicaA.close();
      await replicaB.close();
    });

    it('logout revokes the family and the access token', async () => {
      const session = await login(ctx, ctx.users.student);
      const out = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: bearer(session.accessToken),
        payload: { refreshToken: session.refreshToken },
      });
      expect(out.statusCode).toBe(204);
      expect((await refresh(session.refreshToken)).statusCode).toBe(401);
      const me = await ctx.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: bearer(session.accessToken),
      });
      expect(me.statusCode).toBe(401);
    });
  });

  it('syncs the access mirror and authorizes by enrollment', async () => {
    const section = randomUUID();
    const internal = { 'x-internal-token': INTERNAL_TOKEN };
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/sync/sections',
      headers: internal,
      payload: {
        institutionId: INSTITUTION_A,
        sections: [{ classSectionId: section, professorId: ctx.users.professor.professorId }],
      },
    });
    const sync = await ctx.app.inject({
      method: 'POST',
      url: '/v1/sync/enrollments',
      headers: internal,
      payload: {
        institutionId: INSTITUTION_A,
        enrollments: [{ studentId: ctx.users.student.studentId, classSectionId: section }],
      },
    });
    expect(sync.json<Json>()).toMatchObject({ upserted: 1 });
    const authorize = (userId: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/authorize',
        headers: internal,
        payload: {
          subject: userId,
          action: 'read',
          resource: { type: 'lecture', classSectionId: section },
        },
      });
    expect((await authorize(ctx.users.student.id)).json()).toEqual({
      allowed: true,
      reason: 'enrolled',
    });
    expect((await authorize(ctx.users.otherStudent.id)).json()).toEqual({
      allowed: false,
      reason: 'not_enrolled',
    });
    expect((await authorize(ctx.users.professor.id)).json()).toEqual({
      allowed: true,
      reason: 'teaches_section',
    });
    expect((await authorize(ctx.users.adminB.id)).json()).toEqual({
      allowed: false,
      reason: 'cross_institution',
    });

    await ctx.app.inject({
      method: 'POST',
      url: '/v1/sync/enrollments',
      headers: internal,
      payload: {
        institutionId: INSTITUTION_A,
        mode: 'replace',
        enrollments: [{ studentId: ctx.users.otherStudent.studentId, classSectionId: section }],
      },
    });
    expect((await authorize(ctx.users.student.id)).json()).toEqual({
      allowed: false,
      reason: 'enrollment_inactive',
    });
    const me = await login(ctx, ctx.users.otherStudent);
    const sections = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me/sections',
      headers: bearer(me.accessToken),
    });
    expect(sections.json<Json>()['classSectionIds']).toContain(section);
  });

  it('stores only a secret reference for OIDC and consumes state once', async () => {
    const admin = await login(ctx, ctx.users.admin);
    const config = {
      issuer: 'https://sso.example',
      authorizationEndpoint: 'https://sso.example/authorize',
      tokenEndpoint: 'https://sso.example/token',
      jwksUri: 'https://sso.example/jwks',
      clientId: 'ci',
      redirectUri: 'https://ci.example/callback',
    };
    const put = (payload: Json) =>
      ctx.app.inject({
        method: 'PUT',
        url: `/v1/identity-providers/${INSTITUTION_A}`,
        headers: bearer(admin.accessToken),
        payload,
      });
    const plaintext = await put({ ...config, clientSecret: 'super-secret' });
    expect(plaintext.statusCode).toBe(400);
    expect((plaintext.json<Json>()['error'] as Json)['code']).toBe('secret_reference_required');
    expect((await put({ ...config, clientSecretRef: 'env:SSO_CLIENT_SECRET' })).statusCode).toBe(
      200,
    );
    const row = await db.pool.query(
      'SELECT client_secret_ref FROM identity_provider_configs WHERE institution_id = $1',
      [INSTITUTION_A],
    );
    expect(row.rows[0]).toEqual({ client_secret_ref: 'env:SSO_CLIENT_SECRET' });

    const start = await ctx.app.inject({
      method: 'GET',
      url: `/v1/auth/oidc/${INSTITUTION_A}/start?format=json`,
    });
    const state =
      new URL(start.json<{ authorizationUrl: string }>().authorizationUrl).searchParams.get(
        'state',
      ) ?? '';
    expect(await ctx.deps.repos.oidcStates.consume(state)).toMatchObject({
      institutionId: INSTITUTION_A,
    });
    expect(await ctx.deps.repos.oidcStates.consume(state)).toBeUndefined();
  });

  describe('DSR', () => {
    it('runs the workflow with a partial failure, retry and identity erasure last', async () => {
      const coordinator = (await login(ctx, ctx.users.coordinator)).accessToken;
      const student = await login(ctx, ctx.users.student);
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/v1/dsr',
        headers: bearer(student.accessToken),
        payload: {
          subjectType: 'student',
          subjectId: ctx.users.student.studentId,
          institutionId: INSTITUTION_A,
          type: 'deletion',
          requestedBy: ctx.users.student.id,
          channel: 'web',
        },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json<Json>()['id'] as string;
      const duplicate = await ctx.app.inject({
        method: 'POST',
        url: '/v1/dsr',
        headers: bearer(coordinator),
        payload: {
          subjectType: 'user',
          subjectId: ctx.users.student.id,
          institutionId: INSTITUTION_A,
          type: 'deletion',
          requestedBy: ctx.users.coordinator.id,
          channel: 'email',
        },
      });
      expect(duplicate.statusCode).toBe(409);

      const post = (path: string) =>
        ctx.app.inject({
          method: 'POST',
          url: `/v1/dsr/${id}/${path}`,
          headers: bearer(coordinator),
          payload: {},
        });
      expect((await post('verify')).json<Json>()['status']).toBe('verifying');
      const first = await post('execute');
      expect(first.json<Json>()['status']).toBe('in_progress');
      expect(await ctx.deps.repos.credentials.get(ctx.users.student.id)).toBeDefined();
      const second = await post('execute');
      expect(second.json<Json>()).toMatchObject({
        status: 'completed',
        ranServices: ['notifications', 'identity'],
      });

      const user = await ctx.deps.repos.users.findById(ctx.users.student.id);
      expect(user).toMatchObject({
        status: 'disabled',
        studentId: null,
        name: 'Titular anonimizado',
      });
      expect(await ctx.deps.repos.credentials.get(ctx.users.student.id)).toBeUndefined();

      const detail = (
        await ctx.app.inject({ method: 'GET', url: `/v1/dsr/${id}`, headers: bearer(coordinator) })
      ).json<Json>();
      const timeline = (detail['timeline'] as Json[]).map((e) => e['type']);
      expect(timeline).toEqual([
        'received',
        'verified',
        'execution_started',
        'service_failed',
        'execution_partial',
        'execution_started',
        'service_completed',
        'service_completed',
        'completed',
      ]);
      expect((detail['results'] as Json[]).map((r) => [r['service'], r['attempts']])).toEqual([
        ['identity', 1],
        ['notifications', 2],
      ]);
      await expect(
        db.pool.query('UPDATE dsr_events SET type = $1 WHERE request_id = $2', ['x', id]),
      ).rejects.toThrow();
    });

    it('lists overdue requests from the database', async () => {
      const student = await login(ctx, ctx.users.student);
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/dsr',
        headers: bearer(student.accessToken),
        payload: {
          subjectType: 'student',
          subjectId: ctx.users.student.studentId,
          institutionId: INSTITUTION_A,
          type: 'access',
          requestedBy: ctx.users.student.id,
          channel: 'web',
        },
      });
      ctx.clock.advance(16 * 86_400_000);
      const coordinator = (await login(ctx, ctx.users.coordinator)).accessToken;
      const list = (
        await ctx.app.inject({
          method: 'GET',
          url: '/v1/dsr?overdue=true',
          headers: bearer(coordinator),
        })
      ).json<Json>();
      expect((list['items'] as Json[]).length).toBeGreaterThanOrEqual(1);
      expect((list['items'] as Json[]).every((i) => i['overdue'] === true)).toBe(true);
    });
  });

  it('grace cipher rejects tampering and other keys', () => {
    const sealed = cipher.seal('a', 'secret');
    expect(cipher.open('a', sealed)).toBe('secret');
    expect(cipher.open('b', sealed)).toBeUndefined();
    expect(
      GraceCipher.fromSigningKey(generateSigningKey().privateKey).open('a', sealed),
    ).toBeUndefined();
  });
});
