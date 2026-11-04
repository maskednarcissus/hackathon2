import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HttpDataSubjectHandler,
  InMemoryDsrRepository,
  InMemoryExportStore,
  parseHandlerUrls,
  type DataSubjectHandler,
  type DsrHandlerPayload,
  type DsrHandlerResult,
  type DsrType,
} from './dsr.js';
import {
  bearer,
  INSTITUTION_A,
  INTERNAL_TOKEN,
  login,
  PASSWORD,
  setup,
  type TestContext,
} from './test/helpers.js';

class FakeHandler implements DataSubjectHandler {
  calls: Array<{ type: DsrType; payload: DsrHandlerPayload }> = [];
  constructor(
    readonly name: string,
    private readonly outcomes: Array<'ok' | 'fail' | 'throw' | 'na'> = ['ok'],
  ) {}
  async handle(type: DsrType, payload: DsrHandlerPayload): Promise<DsrHandlerResult> {
    this.calls.push({ type, payload });
    const outcome = this.outcomes[Math.min(this.calls.length - 1, this.outcomes.length - 1)];
    if (outcome === 'throw') throw new Error(`${this.name} exploded`);
    if (outcome === 'fail') {
      return {
        service: this.name,
        status: 'failed',
        items: null,
        error: 'temporarily unavailable',
      };
    }
    if (outcome === 'na') return { service: this.name, status: 'not_applicable', items: null };
    return {
      service: this.name,
      status: 'completed',
      items:
        type === 'access' ? [{ kind: `${this.name}-record`, subjectId: payload.subjectId }] : 3,
    };
  }
}

let ctx: TestContext;
let auditHandler: FakeHandler;
let notificationsHandler: FakeHandler;
let exportStore: InMemoryExportStore;
const internal = { 'x-internal-token': INTERNAL_TOKEN };

async function build(
  notificationsOutcomes: Array<'ok' | 'fail' | 'throw' | 'na'> = ['ok'],
): Promise<void> {
  auditHandler = new FakeHandler('audit');
  notificationsHandler = new FakeHandler('notifications', notificationsOutcomes);
  exportStore = new InMemoryExportStore();
  ctx = await setup({
    dsr: {
      repo: new InMemoryDsrRepository(),
      handlers: [auditHandler, notificationsHandler],
      exportStore,
    },
  });
}

beforeEach(async () => {
  await build();
});
afterEach(async () => {
  await ctx.app.close();
});

type Json = Record<string, unknown>;

const studentRequest = (type: DsrType = 'access', overrides: Json = {}): Json => ({
  subjectType: 'student',
  subjectId: ctx.users.student.studentId,
  institutionId: INSTITUTION_A,
  type,
  requestedBy: ctx.users.student.id,
  channel: 'web',
  ...overrides,
});

async function create(token: string, payload: Json): Promise<{ status: number; body: Json }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/dsr',
    headers: bearer(token),
    payload,
  });
  return { status: res.statusCode, body: res.json<Json>() };
}

async function post(
  path: string,
  token: string,
  payload: Json = {},
): Promise<{ status: number; body: Json }> {
  const res = await ctx.app.inject({ method: 'POST', url: path, headers: bearer(token), payload });
  return { status: res.statusCode, body: res.json<Json>() };
}

async function get(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: Json }> {
  const res = await ctx.app.inject({ method: 'GET', url: path, headers });
  return { status: res.statusCode, body: res.json<Json>() };
}

async function fileAndVerify(type: DsrType): Promise<{ id: string; coordinator: string }> {
  const student = await login(ctx, ctx.users.student);
  const coordinator = (await login(ctx, ctx.users.coordinator)).accessToken;
  const { body } = await create(student.accessToken, studentRequest(type));
  const id = String(body['id']);
  expect(
    (await post(`/v1/dsr/${id}/verify`, coordinator, { method: 'document_check' })).status,
  ).toBe(200);
  return { id, coordinator };
}

describe('creating a DSR request', () => {
  it('lets the subject file a request; due in 15 days; audited', async () => {
    const student = await login(ctx, ctx.users.student);
    const { status, body } = await create(
      student.accessToken,
      studentRequest('access', { requestedBy: randomUUID() }),
    );
    expect(status).toBe(201);
    expect(body['status']).toBe('received');
    expect(new Date(String(body['dueAt'])).getTime() - ctx.clock.now().getTime()).toBe(
      15 * 86_400_000,
    );
    const stored = await ctx.deps.dsr.repo.get(String(body['id']));
    expect(stored?.requestedBy).toBe(ctx.users.student.id); // self-requests are attributed to the caller
    expect(ctx.audit.events.at(-1)).toMatchObject({
      action: 'dsr.received',
      resourceId: body['id'],
    });
  });

  it('lets coordinators and admins file on behalf of a subject', async () => {
    const admin = await login(ctx, ctx.users.admin);
    expect((await create(admin.accessToken, studentRequest('deletion'))).status).toBe(201);
    const coordinator = await login(ctx, ctx.users.coordinator);
    const byUserId = await create(
      coordinator.accessToken,
      studentRequest('access', { subjectType: 'user', subjectId: ctx.users.professor.id }),
    );
    expect(byUserId.status).toBe(201);
  });

  it('forbids filing for someone else unless staff of the same institution', async () => {
    const other = await login(ctx, ctx.users.otherStudent);
    expect((await create(other.accessToken, studentRequest())).status).toBe(403);
    const professor = await login(ctx, ctx.users.professor);
    expect((await create(professor.accessToken, studentRequest())).status).toBe(403);
    const adminB = await login(ctx, ctx.users.adminB);
    const cross = await create(adminB.accessToken, studentRequest());
    expect(cross.status).toBe(403);
    expect((cross.body['error'] as Json)['code']).toBe('cross_institution');
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/v1/dsr', payload: studentRequest() }))
        .statusCode,
    ).toBe(401);
  });

  it('requires the subject to belong to the institution', async () => {
    const admin = await login(ctx, ctx.users.admin);
    const unknown = await create(
      admin.accessToken,
      studentRequest('access', { subjectId: randomUUID() }),
    );
    expect(unknown.status).toBe(422);
    expect((unknown.body['error'] as Json)['code']).toBe('subject_not_in_institution');
    const otherTenant = await create(
      admin.accessToken,
      studentRequest('access', { subjectType: 'user', subjectId: ctx.users.adminB.id }),
    );
    expect(otherTenant.status).toBe(422);
  });

  it('rejects a duplicate open request of the same type', async () => {
    const student = await login(ctx, ctx.users.student);
    expect((await create(student.accessToken, studentRequest())).status).toBe(201);
    expect((await create(student.accessToken, studentRequest())).status).toBe(409);
    expect((await create(student.accessToken, studentRequest('deletion'))).status).toBe(201);
  });

  it('validates type and channel', async () => {
    const student = await login(ctx, ctx.users.student);
    expect(
      (await create(student.accessToken, studentRequest('access', { type: 'portability' }))).status,
    ).toBe(400);
    expect(
      (await create(student.accessToken, studentRequest('access', { channel: 'pigeon' }))).status,
    ).toBe(400);
  });
});

describe('state machine', () => {
  it('received → verifying → in_progress → completed, with export bundle for access', async () => {
    const student = await login(ctx, ctx.users.student);
    const coordinator = (await login(ctx, ctx.users.coordinator)).accessToken;
    const { body } = await create(student.accessToken, studentRequest('access'));
    const id = String(body['id']);

    expect((await post(`/v1/dsr/${id}/execute`, coordinator)).status).toBe(409); // not verified yet
    expect((await post(`/v1/dsr/${id}/verify`, student.accessToken)).status).toBe(403); // staff only
    const verified = await post(`/v1/dsr/${id}/verify`, coordinator, { method: 'document_check' });
    expect(verified.body).toMatchObject({
      status: 'verifying',
      verifiedBy: ctx.users.coordinator.id,
    });
    expect((await post(`/v1/dsr/${id}/verify`, coordinator)).status).toBe(409);

    const executed = await post(`/v1/dsr/${id}/execute`, coordinator);
    expect(executed.status).toBe(200);
    expect(executed.body['status']).toBe('completed');
    expect(executed.body['ranServices']).toEqual(['audit', 'notifications', 'identity']);
    expect(String(executed.body['exportUri'])).toBe(`memory://dsr-exports/${id}.json`);

    const bundle = (await get(`/v1/dsr/${id}/export`, bearer(student.accessToken))).body;
    expect(bundle['format']).toBe('ci-dsr-access-export/v1');
    const services = bundle['services'] as Array<Json>;
    expect(services.map((s) => s['service']).sort()).toEqual([
      'audit',
      'identity',
      'notifications',
    ]);
    const identity = services.find((s) => s['service'] === 'identity')?.['data'] as Json;
    expect(identity['profile']).toMatchObject({
      id: ctx.users.student.id,
      email: ctx.users.student.email,
    });
    expect(identity['roles']).toEqual(['student']);
    expect(identity['loginHistory']).toMatchObject({ succeeded: 1, failed: 0 });

    // The payload sent to handlers names the subject but never carries tokens.
    expect(auditHandler.calls[0]?.payload).toEqual({
      subjectType: 'student',
      subjectId: ctx.users.student.studentId,
      requestId: id,
      institutionId: INSTITUTION_A,
    });

    expect((await post(`/v1/dsr/${id}/execute`, coordinator)).status).toBe(409); // already completed
    expect(ctx.audit.events.map((e) => e.action).filter((a) => a.startsWith('dsr.'))).toEqual([
      'dsr.received',
      'dsr.verified',
      'dsr.execution_started',
      'dsr.completed',
    ]);
  });

  it('exposes per-service results and a timeline', async () => {
    const { id, coordinator } = await fileAndVerify('access');
    await post(`/v1/dsr/${id}/execute`, coordinator);
    const detail = (await get(`/v1/dsr/${id}`, bearer(coordinator))).body;
    expect(
      (detail['results'] as Json[]).map((r) => [r['service'], r['status'], r['attempts']]),
    ).toEqual([
      ['audit', 'completed', 1],
      ['identity', 'completed', 1],
      ['notifications', 'completed', 1],
    ]);
    expect(detail['pendingServices']).toEqual([]);
    const timeline = (detail['timeline'] as Json[]).map((e) => e['type']);
    expect(timeline[0]).toBe('received');
    expect(timeline).toContain('verified');
    expect(timeline).toContain('execution_started');
    expect(timeline.filter((t) => t === 'service_completed')).toHaveLength(3);
    expect(timeline.slice(-2)).toEqual(['export_created', 'completed']);
  });

  it('can be rejected with a reason before execution only', async () => {
    const student = await login(ctx, ctx.users.student);
    const coordinator = (await login(ctx, ctx.users.coordinator)).accessToken;
    const { body } = await create(student.accessToken, studentRequest('correction'));
    const id = String(body['id']);
    expect((await post(`/v1/dsr/${id}/reject`, coordinator, {})).status).toBe(400);
    expect(
      (await post(`/v1/dsr/${id}/reject`, student.accessToken, { reason: 'mudei de ideia' }))
        .status,
    ).toBe(403);
    const rejected = await post(`/v1/dsr/${id}/reject`, coordinator, {
      reason: 'Identidade não confirmada',
    });
    expect(rejected.body).toMatchObject({
      status: 'rejected',
      rejectionReason: 'Identidade não confirmada',
    });
    expect((await post(`/v1/dsr/${id}/verify`, coordinator)).status).toBe(409);
    expect((await post(`/v1/dsr/${id}/execute`, coordinator)).status).toBe(409);
    expect(ctx.audit.events.at(-1)).toMatchObject({ action: 'dsr.rejected' });

    const done = await fileAndVerify('access');
    await post(`/v1/dsr/${done.id}/execute`, done.coordinator);
    expect(
      (await post(`/v1/dsr/${done.id}/reject`, done.coordinator, { reason: 'tarde demais' }))
        .status,
    ).toBe(409);
  });

  it('staff of another institution cannot act on the request', async () => {
    const { id } = await fileAndVerify('access');
    const adminB = (await login(ctx, ctx.users.adminB)).accessToken;
    expect((await post(`/v1/dsr/${id}/execute`, adminB)).status).toBe(403);
    expect((await get(`/v1/dsr/${id}`, bearer(adminB))).status).toBe(404);
    const other = (await login(ctx, ctx.users.otherStudent)).accessToken;
    expect((await get(`/v1/dsr/${id}`, bearer(other))).status).toBe(404);
  });

  it('service callers may act with the internal token and an explicit actorId', async () => {
    const student = await login(ctx, ctx.users.student);
    const { body } = await create(student.accessToken, studentRequest('access'));
    const id = String(body['id']);
    const noActor = await ctx.app.inject({
      method: 'POST',
      url: `/v1/dsr/${id}/verify`,
      headers: internal,
      payload: {},
    });
    expect(noActor.statusCode).toBe(400);
    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/v1/dsr/${id}/verify`,
      headers: internal,
      payload: { actorId: ctx.users.admin.id },
    });
    expect(ok.json<Json>()['status']).toBe('verifying');
  });
});

describe('partial failures and retries', () => {
  it('a failing handler keeps the request in progress; re-execution only re-runs failed handlers', async () => {
    await ctx.app.close();
    await build(['fail', 'ok']);
    const { id, coordinator } = await fileAndVerify('access');

    const first = await post(`/v1/dsr/${id}/execute`, coordinator);
    expect(first.body['status']).toBe('in_progress');
    expect(first.body['exportUri']).toBeNull();
    expect(
      (first.body['results'] as Json[]).find((r) => r['service'] === 'notifications'),
    ).toMatchObject({
      status: 'failed',
      error: 'temporarily unavailable',
    });
    expect(ctx.audit.events.at(-1)).toMatchObject({
      action: 'dsr.execution_partial',
      metadata: { failed: ['notifications'] },
    });

    const second = await post(`/v1/dsr/${id}/execute`, coordinator);
    expect(second.body['status']).toBe('completed');
    expect(second.body['ranServices']).toEqual(['notifications']);
    expect(auditHandler.calls).toHaveLength(1);
    expect(notificationsHandler.calls).toHaveLength(2);
    const detail = (await get(`/v1/dsr/${id}`, bearer(coordinator))).body;
    expect(
      (detail['results'] as Json[]).find((r) => r['service'] === 'notifications')?.['attempts'],
    ).toBe(2);
    expect(detail['executionAttempts']).toBe(2);
    expect(String(detail['exportUri'])).toContain(id);
  });

  it('a throwing handler is recorded as failed instead of crashing the request', async () => {
    await ctx.app.close();
    await build(['throw', 'ok']);
    const { id, coordinator } = await fileAndVerify('access');
    const res = await post(`/v1/dsr/${id}/execute`, coordinator);
    expect(res.status).toBe(200);
    expect(
      (res.body['results'] as Json[]).find((r) => r['service'] === 'notifications'),
    ).toMatchObject({
      status: 'failed',
      error: 'notifications exploded',
    });
  });

  it('deletion: identity is only erased after every other service succeeded', async () => {
    await ctx.app.close();
    await build(['fail', 'ok']);
    const { id, coordinator } = await fileAndVerify('deletion');

    const first = await post(`/v1/dsr/${id}/execute`, coordinator);
    expect(first.body['status']).toBe('in_progress');
    expect((first.body['results'] as Json[]).map((r) => r['service'])).not.toContain('identity');
    // Account still intact while another service has not erased its data.
    expect(await ctx.deps.repos.credentials.get(ctx.users.student.id)).toBeDefined();
    const detail = (await get(`/v1/dsr/${id}`, bearer(coordinator))).body;
    expect(detail['pendingServices']).toEqual(['notifications', 'identity']);

    const second = await post(`/v1/dsr/${id}/execute`, coordinator);
    expect(second.body['status']).toBe('completed');
    expect(second.body['ranServices']).toEqual(['notifications', 'identity']);
    expect(second.body['exportUri']).toBeNull();

    const user = await ctx.deps.repos.users.findById(ctx.users.student.id);
    expect(user).toMatchObject({
      status: 'disabled',
      name: 'Titular anonimizado',
      email: `anon-${ctx.users.student.id}@anonymized.invalid`,
      studentId: null,
    });
    expect(await ctx.deps.repos.credentials.get(ctx.users.student.id)).toBeUndefined();
    expect(await ctx.deps.repos.loginEvents.listByUser(ctx.users.student.id)).toEqual([]);
    const relogin = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: ctx.users.student.email, password: PASSWORD, institutionId: INSTITUTION_A },
    });
    expect(relogin.statusCode).toBe(401);
  });

  it('deletion revokes existing refresh tokens', async () => {
    const session = await login(ctx, ctx.users.student);
    const { id, coordinator } = await fileAndVerify('deletion');
    expect((await post(`/v1/dsr/${id}/execute`, coordinator)).body['status']).toBe('completed');
    const refresh = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
  });
});

describe('identity handler for other request types', () => {
  it('restriction disables the account', async () => {
    const { id, coordinator } = await fileAndVerify('restriction');
    await post(`/v1/dsr/${id}/execute`, coordinator);
    expect((await ctx.deps.repos.users.findById(ctx.users.student.id))?.status).toBe('disabled');
  });

  it('correction applies the requested fields', async () => {
    const student = await login(ctx, ctx.users.student);
    const coordinator = (await login(ctx, ctx.users.coordinator)).accessToken;
    const { body } = await create(
      student.accessToken,
      studentRequest('correction', { details: { name: 'Nome Corrigido' } }),
    );
    const id = String(body['id']);
    await post(`/v1/dsr/${id}/verify`, coordinator);
    const res = await post(`/v1/dsr/${id}/execute`, coordinator);
    expect(res.body['status']).toBe('completed');
    expect((await ctx.deps.repos.users.findById(ctx.users.student.id))?.name).toBe(
      'Nome Corrigido',
    );
    expect(auditHandler.calls[0]?.payload.details).toEqual({ name: 'Nome Corrigido' });
  });
});

describe('listing and overdue', () => {
  it('flags open requests past their due date', async () => {
    const student = await login(ctx, ctx.users.student);
    const coordinator = (await login(ctx, ctx.users.coordinator)).accessToken;
    const open = await create(student.accessToken, studentRequest('correction'));
    const done = await fileAndVerify('access');
    await post(`/v1/dsr/${done.id}/execute`, coordinator);

    let list = (await get('/v1/dsr', bearer(coordinator))).body;
    expect(list['summary']).toEqual({ total: 2, overdue: 0 });

    ctx.clock.advance(16 * 86_400_000);
    // Access tokens live 15 minutes: log in again after the clock jump.
    const fresh = (await login(ctx, ctx.users.coordinator)).accessToken;
    list = (await get('/v1/dsr', bearer(fresh))).body;
    expect(list['summary']).toEqual({ total: 2, overdue: 1 });
    const items = list['items'] as Json[];
    expect(items.find((i) => i['id'] === open.body['id'])).toMatchObject({
      overdue: true,
      daysRemaining: -1,
    });
    expect(items.find((i) => i['id'] === done.id)).toMatchObject({
      overdue: false,
      status: 'completed',
    });

    const overdueOnly = (await get('/v1/dsr?overdue=true', bearer(fresh))).body['items'] as Json[];
    expect(overdueOnly.map((i) => i['id'])).toEqual([open.body['id']]);
    const completed = (await get('/v1/dsr?status=completed', bearer(fresh))).body[
      'items'
    ] as Json[];
    expect(completed.map((i) => i['id'])).toEqual([done.id]);
  });

  it('is staff-only and tenant-scoped', async () => {
    const student = await login(ctx, ctx.users.student);
    await create(student.accessToken, studentRequest());
    expect((await get('/v1/dsr', bearer(student.accessToken))).status).toBe(403);
    const adminB = (await login(ctx, ctx.users.adminB)).accessToken;
    expect(((await get('/v1/dsr', bearer(adminB))).body['items'] as Json[]).length).toBe(0);
    expect((await get(`/v1/dsr?institutionId=${INSTITUTION_A}`, bearer(adminB))).status).toBe(403);
    expect((await get('/v1/dsr', internal)).status).toBe(400);
    expect(
      ((await get(`/v1/dsr?institutionId=${INSTITUTION_A}`, internal)).body['items'] as Json[])
        .length,
    ).toBe(1);
  });
});

describe('HTTP handler client', () => {
  const payload: DsrHandlerPayload = {
    subjectType: 'student',
    subjectId: randomUUID(),
    requestId: randomUUID(),
    institutionId: randomUUID(),
  };

  it('POSTs to {serviceUrl}/internal/v1/dsr/{type} with the internal token', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return Response.json({ service: 'notifications', status: 'completed', items: 4 });
    }) as typeof fetch;
    const handler = new HttpDataSubjectHandler('notifications', 'http://notifications:4006', {
      fetch: fetchImpl,
      internalToken: 'secret',
    });
    const result = await handler.handle('deletion', payload);
    expect(result).toEqual({ service: 'notifications', status: 'completed', items: 4 });
    expect(seen[0]?.url).toBe('http://notifications:4006/internal/v1/dsr/deletion');
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual(payload);
    expect((seen[0]?.init?.headers as Record<string, string>)['x-internal-token']).toBe('secret');
  });

  it('maps HTTP errors, invalid bodies and network errors to failed results', async () => {
    const make = (impl: () => Promise<Response>): HttpDataSubjectHandler =>
      new HttpDataSubjectHandler('audit', 'http://audit', {
        fetch: impl as unknown as typeof fetch,
      });
    expect(
      await make(async () => new Response('boom', { status: 503 })).handle('access', payload),
    ).toMatchObject({
      status: 'failed',
      error: 'HTTP 503',
    });
    expect(
      await make(async () => Response.json({ nope: true })).handle('access', payload),
    ).toMatchObject({
      status: 'failed',
      error: 'invalid handler response',
    });
    expect(
      await make(async () => {
        throw new Error('ECONNREFUSED');
      }).handle('access', payload),
    ).toMatchObject({ status: 'failed', error: 'ECONNREFUSED' });
  });

  it('parses DSR_HANDLER_URLS', () => {
    expect(parseHandlerUrls('audit=http://audit:4011, notifications=http://n:4006')).toEqual([
      { name: 'audit', url: 'http://audit:4011' },
      { name: 'notifications', url: 'http://n:4006' },
    ]);
    expect(parseHandlerUrls(undefined)).toEqual([]);
    expect(() => parseHandlerUrls('audit')).toThrow();
    expect(() => parseHandlerUrls('audit=ftp://x')).toThrow();
    expect(() => parseHandlerUrls('identity=http://x')).toThrow();
  });
});
