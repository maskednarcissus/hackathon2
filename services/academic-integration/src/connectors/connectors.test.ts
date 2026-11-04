import { generateKeyPairSync, createVerify, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { InMemoryAuditClient, StaticOrganizationClient } from '../clients.js';
import type { ImportReport, ScheduledClass } from '../domain.js';
import { InMemoryAcademicRepository } from '../repository.js';
import { FixtureFetch, loadFixture } from '../test/fixture-fetch.js';
import { ConnectorError, ConnectorHttp, Lti13ClientAssertion, OAuth2ClientCredentials, noAuth, type HttpDeps } from './http.js';
import { DefaultConnectorFactory } from './registry.js';
import { StaticSecretResolver } from './secrets.js';
import { ConnectorService } from './service.js';
import { InMemoryConnectorStore, type Publication, type SyncRun } from './store.js';
import type { ConnectorConfig } from './types.js';

export const INST = '11111111-1111-4111-8111-111111111111';
export const ROOM1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const ROOM2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN = 'internal-secret';
const NOW = new Date('2026-11-04T12:00:00Z');
const H = { 'x-internal-token': TOKEN };

export const SECRETS: Record<string, string> = {
  'env:TOTVS_SECRET': 'integracao:s3nha',
  'env:ETHOS_KEY': 'ethos-api-key',
  'env:MOODLE_TOKEN': 'moodle-ws-token',
  'env:CANVAS_TOKEN': 'canvas-token',
  'env:BB_CLIENT': JSON.stringify({ clientId: 'bb-app', clientSecret: 'bb-secret' }),
};

/** SIS data the LMS tests attach enrollments to (term 2026-2, section 1001). */
export const SIS_IMPORT = {
  institutionId: INST,
  term: { externalId: '2026-2', name: '2026/2', startDate: '2026-08-03', endDate: '2026-12-11' },
  courses: [{ externalId: 'DIR101', code: 'DIR101', name: 'Direito Constitucional I', discipline: 'law' }],
  professors: [{ externalId: 'P1', name: 'Ana Souza', email: 'ana.souza@uni.example' }],
  students: [
    { externalId: '2026001', name: 'Bruno Lima', email: 'bruno@uni.example' },
    { externalId: '2026002', name: 'Carla Dias', email: 'carla@uni.example' },
  ],
  classSections: [
    {
      externalId: '1001',
      courseExternalId: 'DIR101',
      professorExternalId: 'P1',
      sectionCode: 'A',
      schedule: [{ dayOfWeek: 3, startTime: '19:00', endTime: '20:40', classroomId: ROOM1 }],
    },
  ],
};

export interface Harness {
  app: ReturnType<typeof buildApp>;
  http: FixtureFetch;
  sleeps: number[];
  audit: InMemoryAuditClient;
  store: InMemoryConnectorStore;
  repo: InMemoryAcademicRepository;
  clock: { t: number };
}

export function harness(fixture: string, deps: Partial<{ store: InMemoryConnectorStore; repo: InMemoryAcademicRepository }> = {}): Harness {
  const repo = deps.repo ?? new InMemoryAcademicRepository();
  const store = deps.store ?? new InMemoryConnectorStore();
  const audit = new InMemoryAuditClient();
  const http = new FixtureFetch(loadFixture(fixture));
  const sleeps: number[] = [];
  const clock = { t: NOW.getTime() };
  const httpDeps: HttpDeps = {
    fetch: http.fetch as typeof fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    now: () => clock.t,
  };
  const factory = new DefaultConnectorFactory(new StaticSecretResolver(SECRETS), httpDeps);
  const appClock = { now: () => new Date(clock.t) };
  const app = buildApp({
    repository: repo,
    organization: new StaticOrganizationClient(),
    audit,
    clock: appClock,
    internalToken: TOKEN,
    connectors: (runImport) =>
      new ConnectorService({ store, repository: repo, runImport, factory, audit, clock: appClock, newId: randomUUID }),
  });
  return { app, http, sleeps, audit, store, repo, clock };
}

export async function configure(h: Harness, type: string, body: Record<string, unknown>): Promise<ConnectorConfig> {
  const res = await h.app.inject({ method: 'PUT', url: `/v1/connectors/${INST}/${type}`, headers: H, payload: body });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json<ConnectorConfig>();
}

export async function sync(h: Harness, type: string, body: Record<string, unknown> = {}): Promise<{ status: number; run: SyncRun }> {
  const res = await h.app.inject({ method: 'POST', url: `/v1/connectors/${INST}/${type}/sync`, headers: H, payload: body });
  return { status: res.statusCode, run: res.json<SyncRun>() };
}

export async function importSis(h: Harness): Promise<void> {
  const res = await h.app.inject({ method: 'POST', url: '/v1/imports', payload: SIS_IMPORT });
  expect(res.statusCode, res.body).toBe(201);
}

const codes = (run: SyncRun): string[] => run.warnings.map((w) => w.code);

const TOTVS_CONFIG = {
  baseUrl: 'https://rm.uni.example/',
  auth: { kind: 'basic', secretRef: 'env:TOTVS_SECRET' },
  mappings: { termExternalId: '2026-2', rooms: { S101: ROOM1, S102: ROOM2 }, pageSize: 2 },
};

describe('connector configuration', () => {
  it('requires the internal token and validates configs', async () => {
    const h = harness('totvs_rm');
    const unauth = await h.app.inject({ method: 'PUT', url: `/v1/connectors/${INST}/totvs_rm`, payload: TOTVS_CONFIG });
    expect(unauth.statusCode).toBe(401);
    const put = (type: string, body: unknown) =>
      h.app.inject({ method: 'PUT', url: `/v1/connectors/${INST}/${type}`, headers: H, payload: body as Record<string, unknown> });
    // inline secrets are rejected; only references are stored
    expect((await put('totvs_rm', { ...TOTVS_CONFIG, auth: { kind: 'basic', secretRef: 'env:X', password: 'p' } })).statusCode).toBe(400);
    expect((await put('totvs_rm', { ...TOTVS_CONFIG, auth: { kind: 'basic', secretRef: 'plain-text' } })).statusCode).toBe(400);
    expect((await put('sap', TOTVS_CONFIG)).statusCode).toBe(400);
    expect(
      (await put('banner', { ...TOTVS_CONFIG, outbound: { enabled: true, courses: { [ROOM1]: { lmsCourseId: '1' } } } })).json(),
    ).toMatchObject({ error: { code: 'outbound_not_supported' } });

    const created = await put('totvs_rm', TOTVS_CONFIG);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ baseUrl: 'https://rm.uni.example', auth: { secretRef: 'env:TOTVS_SECRET' } });
    expect(JSON.stringify(created.json())).not.toContain('s3nha');
    expect((await put('totvs_rm', { ...TOTVS_CONFIG, enabled: false })).statusCode).toBe(200);
    const list = await h.app.inject({ url: `/v1/connectors/${INST}`, headers: H });
    expect(list.json<{ items: ConnectorConfig[] }>().items.map((c) => [c.type, c.enabled])).toEqual([['totvs_rm', false]]);
    expect((await sync(h, 'totvs_rm')).status).toBe(409);
    expect((await sync(h, 'canvas')).status).toBe(404);
    expect(h.audit.events.map((e) => e.action)).toContain('integration.connector_configured');
  });
});

describe('TOTVS RM', () => {
  it('pulls with paging and 429 handling, dry-runs, applies and keeps history', async () => {
    const h = harness('totvs_rm');
    await configure(h, 'totvs_rm', TOTVS_CONFIG);

    const dry = await sync(h, 'totvs_rm', { dryRun: true, triggeredBy: 'admin-1' });
    expect(dry.status, JSON.stringify(dry.run)).toBe(200);
    expect(dry.run).toMatchObject({ status: 'succeeded', importStatus: 'validated', dryRun: true, since: null });
    expect(await h.repo.findScheduledClasses({ institutionId: INST })).toEqual([]);

    const applied = await sync(h, 'totvs_rm');
    expect(applied.run).toMatchObject({ status: 'succeeded', importStatus: 'applied' });
    expect(applied.run.counts).toMatchObject({
      terms: { created: 1 },
      courses: { created: 3 },
      professors: { created: 2 },
      students: { created: 2 },
      classSections: { created: 1 },
      enrollments: { created: 2 },
    });
    expect(codes(applied.run)).toEqual(
      expect.arrayContaining([
        'connector.unmapped_room',
        'connector.no_schedule',
        'connector.missing_professor',
        'connector.invalid_slot',
        'connector.missing_email',
        'connector.unknown_status',
      ]),
    );
    const classes = await h.repo.findScheduledClasses({ institutionId: INST });
    const first = classes[0] as ScheduledClass;
    expect(new Set(classes.map((c) => c.classroomId))).toEqual(new Set([ROOM1, ROOM2]));
    expect(first.startsAt).toBe('2026-08-03T22:00:00.000Z'); // Monday 19:00 America/Sao_Paulo
    const snap = await h.repo.snapshot(INST);
    expect(snap.professors.get('P1')?.email).toBe('ana.souza@uni.example');
    const statuses = [...snap.enrollments.values()].map((e) => e.status).sort();
    expect(statuses).toEqual(['active', 'withdrawn']);

    // paging, auth and rate limit
    expect(h.http.unmatched).toEqual([]);
    expect(h.http.callsTo('/api/educacional/v1/disciplinas').map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2', '1', '2']);
    expect(h.http.calls[0]?.headers['authorization']).toBe(`Basic ${Buffer.from('integracao:s3nha').toString('base64')}`);
    expect(h.http.calls.every((c) => c.url.searchParams.get('codColigada') === '1' || !c.url.pathname.startsWith('/api/educacional'))).toBe(true);
    expect(h.sleeps).toContain(2000);
    expect(applied.run.stats).toMatchObject({ rateLimited: 1, incremental: false });

    // incremental: the next sync passes the last successful run as `dataAlteracao`
    h.clock.t += 3_600_000;
    const incremental = await sync(h, 'totvs_rm');
    expect(incremental.run.since).toBe(applied.run.startedAt);
    const last = h.http.callsTo('/api/educacional/v1/matriculas').at(-1);
    expect(last?.url.searchParams.get('dataAlteracao')).toBe(applied.run.startedAt);
    expect(incremental.run.counts?.enrollments).toMatchObject({ created: 0, unchanged: 2 });

    const runs = await h.app.inject({ url: `/v1/connectors/${INST}/totvs_rm/runs?limit=10`, headers: H });
    expect(runs.json<{ items: SyncRun[] }>().items.map((r) => [r.dryRun, r.status])).toEqual([
      [false, 'succeeded'],
      [false, 'succeeded'],
      [true, 'succeeded'],
    ]);
    const one = await h.app.inject({ url: `/v1/connector-runs/${dry.run.id}`, headers: H });
    expect(one.json<SyncRun>().triggeredBy).toBe('admin-1');
    const report = await h.app.inject({ url: `/v1/imports/${applied.run.importId ?? ''}` });
    expect(report.json<ImportReport>().format).toBe('connector');
    expect(h.audit.events.filter((e) => e.action === 'integration.connector_synced')).toHaveLength(3);
  });

  it('fails the run when the upstream is unavailable or misconfigured', async () => {
    const h = harness('totvs_rm');
    h.http.prepend({ path: '/api/framework/v1/companies/1', responses: [{ status: 503 }] });
    await configure(h, 'totvs_rm', TOTVS_CONFIG);
    const failed = await sync(h, 'totvs_rm');
    expect(failed.status).toBe(502);
    expect(failed.run).toMatchObject({ status: 'failed', error: { code: 'upstream_unavailable' } });
    expect(h.sleeps).toEqual([500, 1000, 2000, 4000]);
    await configure(h, 'totvs_rm', { ...TOTVS_CONFIG, mappings: {} });
    expect((await sync(h, 'totvs_rm')).run.error?.code).toBe('invalid_config');
    // a failed sync never moves the incremental watermark
    expect((await h.store.getConfig(INST, 'totvs_rm'))?.lastSuccessfulSyncAt).toBeNull();
  });

  it('rejects a concurrent sync of the same connector', async () => {
    const h = harness('totvs_rm');
    await configure(h, 'totvs_rm', TOTVS_CONFIG);
    const running: SyncRun = {
      id: randomUUID(), institutionId: INST, type: 'totvs_rm', status: 'running', dryRun: false, since: null,
      triggeredBy: null, importId: null, importStatus: null, counts: null, warnings: [], errors: [], error: null,
      stats: null, startedAt: NOW.toISOString(), finishedAt: null,
    };
    expect(await h.store.startRun(running, NOW)).toBe(true);
    const res = await sync(h, 'totvs_rm');
    expect(res.status).toBe(409);
    // an abandoned run (crashed instance) stops blocking after two hours
    h.clock.t += 3 * 3_600_000;
    expect((await sync(h, 'totvs_rm')).run.status).toBe('succeeded');
    expect((await h.store.getRun(running.id))?.error?.code).toBe('abandoned');
  });
});

const ETHOS_CONFIG = {
  baseUrl: 'https://integrate.elluciancloud.com',
  auth: { kind: 'api_key', secretRef: 'env:ETHOS_KEY' },
  mappings: { termExternalId: 'AP1', rooms: { 'ROOM-GUID-1': ROOM1, B202: ROOM2 }, pageSize: 2, concurrency: 1 },
};

describe('Ellucian Ethos (Banner, Colleague)', () => {
  it('Banner: maps sections, instructional events, instructors and registrations; partial on a failing section', async () => {
    const h = harness('ethos');
    await configure(h, 'banner', ETHOS_CONFIG);
    const { status, run } = await sync(h, 'banner');
    expect(status, JSON.stringify(run)).toBe(200);
    expect(run.status).toBe('partial');
    expect(codes(run)).toEqual(expect.arrayContaining(['connector.fetch_failed', 'connector.invalid_slot', 'connector.unknown_person']));
    const snap = await h.repo.snapshot(INST);
    expect(snap.terms.get('202620')).toMatchObject({ name: '2026/2', startDate: '2026-08-03', endDate: '2026-12-11' });
    expect(snap.courses.get('C1')).toMatchObject({ code: 'DIR101', discipline: 'Direito' });
    const s1 = snap.classSections.get('202620-10001');
    expect(s1?.schedule).toEqual([
      { dayOfWeek: 1, startTime: '19:00', endTime: '20:40', classroomId: ROOM1 },
      { dayOfWeek: 3, startTime: '19:00', endTime: '20:40', classroomId: ROOM1 },
    ]);
    expect(snap.classSections.get('202620-10002')?.schedule).toEqual([
      { dayOfWeek: 2, startTime: '08:00', endTime: '09:40', classroomId: ROOM2 },
    ]);
    expect(snap.classSections.has('202620-10003')).toBe(false);
    expect(snap.professors.get('B0001')?.email).toBe('ana.souza@uni.example');
    expect([...snap.students.keys()].sort()).toEqual(['B1001', 'B1002']);
    expect(
      [...snap.enrollments.values()].map((e) => e.status).sort(),
    ).toEqual(['active', 'active', 'withdrawn']);
    // auth once, JWT reused, versioned media types, offset paging
    expect(h.http.callsTo('/auth')).toHaveLength(1);
    const sectionsCalls = h.http.callsTo('/api/sections');
    expect(sectionsCalls.map((c) => c.url.searchParams.get('offset'))).toEqual(['0', '2']);
    expect(sectionsCalls[0]?.headers['authorization']).toBe('Bearer eyJ.ethos.jwt');
    expect(sectionsCalls[0]?.headers['accept']).toBe('application/vnd.hedtech.integration.v16+json');
    expect(h.http.unmatched).toEqual([]);
  });

  it('Colleague uses the Colleague person id as external id', async () => {
    const h = harness('ethos');
    await configure(h, 'colleague', ETHOS_CONFIG);
    const { run } = await sync(h, 'colleague');
    expect(run.status).toBe('partial');
    const snap = await h.repo.snapshot(INST);
    expect([...snap.professors.keys()]).toEqual(['0000001']);
    expect([...snap.students.keys()].sort()).toEqual(['0001001', '0001002']);
  });
});

const lmsConfig = (type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
  const base: Record<string, Record<string, unknown>> = {
    moodle: { baseUrl: 'https://moodle.uni.example', auth: { kind: 'api_key', secretRef: 'env:MOODLE_TOKEN' } },
    canvas: { baseUrl: 'https://canvas.example', auth: { kind: 'api_key', secretRef: 'env:CANVAS_TOKEN' } },
    blackboard: {
      baseUrl: 'https://learn.uni.example',
      auth: { kind: 'oauth2_client_credentials', secretRef: 'env:BB_CLIENT' },
    },
  };
  return { ...base[type], mappings: { termExternalId: '2026-2', pageSize: 2 }, ...extra };
};

describe('LMS inbound', () => {
  it('Moodle: enrolled students of mapped courses, paged; SIS data wins for existing students', async () => {
    const h = harness('moodle');
    await importSis(h);
    await configure(h, 'moodle', lmsConfig('moodle'));
    const { status, run } = await sync(h, 'moodle');
    expect(status, JSON.stringify(run)).toBe(200);
    expect(run.status).toBe('succeeded');
    expect(codes(run)).toEqual(
      expect.arrayContaining(['connector.missing_id', 'connector.unknown_section', 'connector.unmapped_courses']),
    );
    expect(run.counts).toMatchObject({ students: { created: 1, unchanged: 1 }, enrollments: { created: 2 }, terms: { unchanged: 1 } });
    const snap = await h.repo.snapshot(INST);
    expect(snap.students.get('2026001')).toMatchObject({ name: 'Bruno Lima', email: 'bruno@uni.example' });
    expect(snap.students.get('2026004')?.email).toBe('davi@uni.example');
    const users = h.http.calls.filter((c) => c.url.searchParams.get('wsfunction') === 'core_enrol_get_enrolled_users' && c.url.searchParams.get('courseid') === '10');
    expect(users.map((c) => c.url.searchParams.get('options[1][value]'))).toEqual(['0', '2', '4']);
    expect(users[0]?.url.searchParams.get('wstoken')).toBe('moodle-ws-token');
    expect(h.http.unmatched).toEqual([]);
  });

  it('Moodle: an invalid token fails the run; LMS needs an imported term', async () => {
    const h = harness('moodle');
    h.http.prepend({
      path: '/webservice/rest/server.php',
      query: { wsfunction: 'core_course_get_courses' },
      responses: [{ body: { exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Invalid token' } }],
    });
    await configure(h, 'moodle', lmsConfig('moodle'));
    const failed = await sync(h, 'moodle');
    expect(failed.status).toBe(502);
    expect(failed.run.error?.code).toBe('auth_failed');
    const h2 = harness('moodle');
    await configure(h2, 'moodle', lmsConfig('moodle'));
    expect((await sync(h2, 'moodle')).run.error?.code).toBe('term_not_found');
    await configure(h2, 'moodle', lmsConfig('moodle', { mappings: {} }));
    expect((await sync(h2, 'moodle')).status).toBe(409);
  });

  it('Canvas: Link paging, 429 Retry-After, sis_section_id mapping and enrollment states', async () => {
    const h = harness('canvas');
    await importSis(h);
    await configure(h, 'canvas', lmsConfig('canvas'));
    const { run } = await sync(h, 'canvas');
    expect(run.status, JSON.stringify(run)).toBe('succeeded');
    expect(codes(run)).toEqual(expect.arrayContaining(['connector.unmapped_sections', 'connector.unknown_section', 'connector.missing_id']));
    const snap = await h.repo.snapshot(INST);
    const byStudent = Object.fromEntries(
      [...snap.enrollments.values()].map((e) => [[...snap.students.values()].find((s) => s.id === e.studentId)?.externalId, e.status]),
    );
    expect(byStudent).toEqual({ '2026001': 'active', '2026002': 'withdrawn', '2026004': 'completed' });
    expect(h.http.callsTo('/api/v1/courses').map((c) => c.url.search)).toEqual(['?per_page=2', '?page=2&per_page=2']);
    expect(h.sleeps).toEqual([1000]);
    expect(h.http.calls[0]?.headers['authorization']).toBe('Bearer canvas-token');
    expect(h.http.unmatched).toEqual([]);
  });

  it('Blackboard: OAuth2 token with refresh on 401, nextPage paging, partial failure', async () => {
    const h = harness('blackboard');
    await importSis(h);
    await configure(h, 'blackboard', lmsConfig('blackboard', { mappings: { termExternalId: '2026-2', pageSize: 2, sections: { MAPPED: '1001' } } }));
    const { status, run } = await sync(h, 'blackboard');
    expect(status).toBe(200);
    expect(run.status, JSON.stringify(run)).toBe('partial');
    const tokens = h.http.callsTo('/learn/api/public/v1/oauth2/token');
    expect(tokens).toHaveLength(2);
    expect(tokens[0]?.headers['authorization']).toBe(`Basic ${Buffer.from('bb-app:bb-secret').toString('base64')}`);
    expect(tokens[0]?.body).toBe('grant_type=client_credentials');
    expect(h.http.callsTo('/learn/api/public/v1/courses/_1_1/users').at(-1)?.headers['authorization']).toBe('Bearer bb-token-2');
    const snap = await h.repo.snapshot(INST);
    expect([...snap.enrollments.values()].map((e) => e.status).sort()).toEqual(['active', 'active', 'withdrawn']);
    expect(codes(run)).toEqual(expect.arrayContaining(['connector.fetch_failed', 'connector.unknown_section']));
    expect(h.http.unmatched).toEqual([]);
  });
});

describe('LMS outbound publication', () => {
  const calendarEvent = (id: string, sectionId: string): Record<string, unknown> => ({
    eventId: randomUUID(),
    type: 'calendar.event_published',
    version: 1,
    occurredAt: NOW.toISOString(),
    source: 'calendar',
    institutionId: INST,
    data: {
      calendarEventId: id,
      event: {
        id,
        institutionId: INST,
        classSectionId: sectionId,
        type: 'examination',
        title: 'Prova 1',
        description: 'Capítulos 1 a 3 <b>com consulta</b>',
        eventDate: '2026-11-18',
        eventTime: '19:00',
        timezone: 'America/Sao_Paulo',
        status: 'published',
      },
    },
  });
  const push = (env: Record<string, unknown>) => ({
    message: { data: Buffer.from(JSON.stringify(env)).toString('base64'), messageId: '1' },
    subscription: 'projects/p/subscriptions/academic-integration-lms',
  });

  it('Canvas: posts announcement + calendar item for opted-in courses, idempotently', async () => {
    const h = harness('canvas');
    await importSis(h);
    const section = (await h.repo.snapshot(INST)).classSections.get('1001');
    const sectionId = section?.id ?? '';
    await configure(
      h,
      'canvas',
      lmsConfig('canvas', {
        outbound: {
          enabled: true,
          lectureUrlTemplate: 'https://app.uni.example/aulas/{lectureSummaryId}',
          courses: { [sectionId]: { lmsCourseId: 'C-101' } },
        },
      }),
    );
    const id = randomUUID();
    const event = calendarEvent(id, sectionId);
    const url = '/v1/events/calendar-event-published';
    expect((await h.app.inject({ method: 'POST', url, payload: push(event) })).statusCode).toBe(401);
    const res = await h.app.inject({ method: 'POST', url, headers: H, payload: push(event) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ published: 2, failed: 0 });
    const [ann] = h.http.callsTo('/api/v1/courses/C-101/discussion_topics');
    expect(JSON.parse(ann?.body ?? '{}')).toMatchObject({
      title: 'Prova 1 — 18/11/2026 às 19:00',
      is_announcement: true,
      message: expect.stringContaining('Capítulos 1 a 3 &lt;b&gt;com consulta&lt;/b&gt;') as unknown,
    });
    const [cal] = h.http.callsTo('/api/v1/calendar_events');
    expect(JSON.parse(cal?.body ?? '{}')).toMatchObject({
      calendar_event: { context_code: 'course_C-101', title: 'Prova 1', start_at: '2026-11-18T22:00:00.000Z', all_day: false },
    });
    // redelivery (new eventId, same calendar event) does not post twice
    const again = await h.app.inject({ method: 'POST', url, headers: H, payload: { ...event, eventId: randomUUID() } });
    expect(again.json()).toMatchObject({ published: 0, skipped: 2 });
    // a section that did not opt in gets nothing
    const other = await h.app.inject({ method: 'POST', url, headers: H, payload: calendarEvent(randomUUID(), randomUUID()) });
    expect(other.json()).toMatchObject({ published: 0, skipped: 0 });

    // lecture.structured → announcement with the lecture link (no calendar item)
    const [sc] = await h.repo.findScheduledClasses({ classSectionId: sectionId });
    const summaryId = randomUUID();
    const lecture = await h.app.inject({
      method: 'POST',
      url: '/v1/events/lecture-structured',
      headers: H,
      payload: {
        eventId: randomUUID(),
        type: 'lecture.structured',
        institutionId: INST,
        data: { scheduledClassId: sc?.id, transcriptId: randomUUID(), lectureSummaryId: summaryId },
      },
    });
    expect(lecture.json()).toMatchObject({ published: 1 });
    const posted = JSON.parse(h.http.callsTo('/api/v1/courses/C-101/discussion_topics').at(-1)?.body ?? '{}') as { title: string; message: string };
    const [y, mo, d] = (sc?.localDate ?? '').split('-');
    expect(posted.title).toBe(`Resumo da aula de ${d ?? ''}/${mo ?? ''}/${y ?? ''} disponível`);
    expect(posted.message).toContain(`https://app.uni.example/aulas/${summaryId}`);
    const pubs = await h.app.inject({ url: `/v1/connectors/${INST}/canvas/publications`, headers: H });
    expect(pubs.json<{ items: Publication[] }>().items.map((p) => [p.sourceType, p.kind, p.status]).sort()).toEqual([
      ['calendar_event', 'announcement', 'published'],
      ['calendar_event', 'calendar_item', 'published'],
      ['lecture_summary', 'announcement', 'published'],
    ]);
    expect(h.audit.events.filter((e) => e.action === 'integration.lms_published')).toHaveLength(3);
  });

  it('Blackboard: a failed publication answers 503 and is retried on redelivery only for what failed', async () => {
    const h = harness('blackboard');
    await importSis(h);
    const sectionId = (await h.repo.snapshot(INST)).classSections.get('1001')?.id ?? '';
    await configure(h, 'blackboard', lmsConfig('blackboard', { outbound: { enabled: true, courses: { [sectionId]: { lmsCourseId: '_1_1' } } } }));
    const event = calendarEvent(randomUUID(), sectionId);
    const first = await h.app.inject({ method: 'POST', url: '/v1/events/calendar-event-published', headers: H, payload: event });
    expect(first.statusCode).toBe(503);
    expect(first.json()).toMatchObject({ published: 1, failed: 1 });
    const second = await h.app.inject({ method: 'POST', url: '/v1/events/calendar-event-published', headers: H, payload: event });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ published: 1, skipped: 1, failed: 0 });
    expect(h.http.callsTo('/learn/api/public/v1/calendars/items')).toHaveLength(1);
    const pubs = (await h.store.listPublications(INST, 'blackboard', 10)).find((p) => p.kind === 'announcement');
    expect(pubs).toMatchObject({ status: 'published', attempts: 2, externalId: '_a1' });
  });

  it('Moodle: announcements go to the configured news forum; calendar items as course events', async () => {
    const h = harness('moodle');
    await importSis(h);
    const sectionId = (await h.repo.snapshot(INST)).classSections.get('1001')?.id ?? '';
    await configure(h, 'moodle', lmsConfig('moodle', { outbound: { enabled: true, courses: { [sectionId]: { lmsCourseId: '10' } } } }));
    const event = calendarEvent(randomUUID(), sectionId);
    const noForum = await h.app.inject({ method: 'POST', url: '/v1/events/calendar-event-published', headers: H, payload: event });
    expect(noForum.json()).toMatchObject({ published: 1, failed: 1 });
    await configure(h, 'moodle', lmsConfig('moodle', { outbound: { enabled: true, courses: { [sectionId]: { lmsCourseId: '10', forumId: '42' } } } }));
    const ok = await h.app.inject({ method: 'POST', url: '/v1/events/calendar-event-published', headers: H, payload: event });
    expect(ok.json()).toMatchObject({ published: 1, skipped: 1 });
    const forum = h.http.calls.find((c) => c.url.searchParams.get('wsfunction') === 'mod_forum_add_discussion');
    expect(new URLSearchParams(forum?.body ?? '').get('forumid')).toBe('42');
    const cal = h.http.calls.find((c) => c.url.searchParams.get('wsfunction') === 'core_calendar_create_calendar_events');
    const form = new URLSearchParams(cal?.body ?? '');
    expect(form.get('events[0][courseid]')).toBe('10');
    expect(form.get('events[0][timestart]')).toBe(String(Date.parse('2026-11-18T22:00:00Z') / 1000));
    expect(form.get('events[0][timeduration]')).toBe('3600');
  });
});

describe('HTTP plumbing', () => {
  const deps = (fetchFn: typeof fetch, sleeps: number[] = [], now = () => NOW.getTime()): HttpDeps => ({
    fetch: fetchFn,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    now,
  });

  it('honours Retry-After dates and gives up on long waits', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const http = new ConnectorHttp('https://x.example', noAuth, deps((() => {
      n++;
      return Promise.resolve(
        n === 1
          ? new Response('', { status: 429, headers: { 'retry-after': new Date(NOW.getTime() + 5000).toUTCString() } })
          : new Response('[]', { status: 200 }),
      );
    }) as typeof fetch, sleeps));
    await http.get('/a');
    expect(sleeps).toEqual([5000]);
    const slow = new ConnectorHttp('https://x.example', noAuth, deps((() =>
      Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '3600' } }))) as typeof fetch));
    await expect(slow.get('/a')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('never follows links to another origin', () => {
    const http = new ConnectorHttp('https://canvas.example', noAuth, deps(globalThis.fetch));
    expect(() => http.url('https://evil.example/api/v1/courses?page=2')).toThrow(ConnectorError);
    expect(http.url('https://canvas.example/api/v1/courses?page=2').search).toBe('?page=2');
  });

  it('caches OAuth2 tokens until shortly before expiry', async () => {
    let t = NOW.getTime();
    let issued = 0;
    const fetchFn = (() => {
      issued++;
      return Promise.resolve(Response.json({ access_token: `t${issued}`, expires_in: 120 }));
    }) as typeof fetch;
    const auth = new OAuth2ClientCredentials(deps(fetchFn, [], () => t), 'https://idp.example/token', 'id', 'secret', 'read');
    expect((await auth.apply()).headers.authorization).toBe('Bearer t1');
    t += 60_000;
    expect((await auth.apply()).headers.authorization).toBe('Bearer t1');
    t += 40_000; // within 30 s of expiry → refresh
    expect((await auth.apply()).headers.authorization).toBe('Bearer t2');
  });

  it('LTI 1.3: signs an RS256 client assertion for the platform token endpoint', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    let body = '';
    const fetchFn = ((_url: string, init?: RequestInit) => {
      body = String(init?.body);
      return Promise.resolve(Response.json({ access_token: 'lti-token', expires_in: 3600 }));
    }) as typeof fetch;
    const auth = new Lti13ClientAssertion(deps(fetchFn), 'https://lms.example/token', 'client-1', pem, 'kid-1', 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly');
    expect((await auth.apply()).headers.authorization).toBe('Bearer lti-token');
    const form = new URLSearchParams(body);
    expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    const [header, claims, signature] = (form.get('client_assertion') ?? '').split('.');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
    expect(JSON.parse(Buffer.from(claims ?? '', 'base64url').toString())).toMatchObject({ iss: 'client-1', sub: 'client-1', aud: 'https://lms.example/token' });
    const ok = createVerify('RSA-SHA256').update(`${header ?? ''}.${claims ?? ''}`).verify(publicKey, Buffer.from(signature ?? '', 'base64url'));
    expect(ok).toBe(true);
  });
});
