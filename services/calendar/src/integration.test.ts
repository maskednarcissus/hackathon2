import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import type { CalendarEvent } from './domain.js';
import {
  HttpEventBusPublisher,
  InMemoryEventPublisher,
  type CalendarEventPayload,
  type EventEnvelope,
} from './events.js';
import { InMemoryFeedTokenRepository } from './feed-tokens.js';
import { createAccessTokenVerifier, type AccessTokenClaims } from './jwt-verify.js';
import { InMemoryCalendarRepository, VersionConflictError } from './repository.js';

const INSTITUTION = randomUUID();
const OTHER_INSTITUTION = randomUUID();
const COURSE = randomUUID();
const SECTION = randomUUID();
const STUDENT = randomUUID();
const OTHER_STUDENT = randomUUID();
const INTERNAL = 'calendar-internal-token';

const keys = generateKeyPairSync('ed25519');
const b64 = (v: object): string => Buffer.from(JSON.stringify(v)).toString('base64url');
let now = new Date('2026-11-04T22:30:00.000Z');

function token(overrides: Partial<AccessTokenClaims> = {}): string {
  const iat = Math.floor(now.getTime() / 1000);
  const claims: AccessTokenClaims = {
    iss: 'ci-identity',
    sub: randomUUID(),
    aud: 'ci',
    iat,
    exp: iat + 900,
    jti: randomUUID(),
    inst: INSTITUTION,
    role: 'student',
    pid: STUDENT,
    ...overrides,
  };
  const input = `${b64({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' })}.${b64(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), keys.privateKey).toString('base64url')}`;
}

const provenance = {
  recordingSessionId: randomUUID(),
  transcriptId: randomUUID(),
  segmentIndex: 42,
  startMs: 2_461_000,
  endMs: 2_468_500,
  quote: 'nossa segunda prova será no dia 20 de novembro',
  confirmedBy: randomUUID(),
  confirmedAt: '2026-11-04T22:00:00.000Z',
};

let app: FastifyInstance;
let events: InMemoryEventPublisher;
let feedTokens: InMemoryFeedTokenRepository;
let repository: InMemoryCalendarRepository;

const internal = { 'x-internal-token': INTERNAL };
const auth = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` });

beforeEach(async () => {
  now = new Date('2026-11-04T22:30:00.000Z');
  events = new InMemoryEventPublisher();
  feedTokens = new InMemoryFeedTokenRepository();
  repository = new InMemoryCalendarRepository();
  app = buildApp({
    repository,
    events,
    feedTokens,
    clock: { now: () => now },
    internalToken: INTERNAL,
    verifyAccessToken: createAccessTokenVerifier({ getKey: () => keys.publicKey, now: () => now }),
  });
  await app.inject({
    method: 'POST',
    url: '/v1/sections',
    headers: internal,
    payload: {
      sections: [
        {
          classSectionId: SECTION,
          institutionId: INSTITUTION,
          courseId: COURSE,
          courseName: 'Cálculo I',
          sectionCode: 'T1',
        },
      ],
    },
  });
  await app.inject({
    method: 'POST',
    url: '/v1/enrollments/bulk',
    headers: internal,
    payload: { classSectionId: SECTION, studentIds: [STUDENT, OTHER_STUDENT], mode: 'replace' },
  });
});

const publish = (
  overrides: Record<string, unknown> = {},
  headers: Record<string, string> = internal,
) =>
  app.inject({
    method: 'POST',
    url: '/v1/calendar-events',
    headers,
    payload: {
      institutionId: INSTITUTION,
      courseId: COURSE,
      classSectionId: SECTION,
      extractedEventId: EXTRACTED,
      type: 'examination',
      title: 'Prova 2',
      eventDate: '2026-11-20',
      eventTime: '19:00',
      isOfficial: true,
      provenance,
      changedBy: provenance.confirmedBy,
      changeSource: 'professor',
      ...overrides,
    },
  });
const EXTRACTED = randomUUID();

describe('event bus publishing', () => {
  it('publishes calendar.event_published with the full event inline', async () => {
    const res = await publish();
    expect(res.statusCode).toBe(201);
    expect(events.published).toHaveLength(1);
    const env = events.published[0] as EventEnvelope<CalendarEventPayload>;
    expect(env).toMatchObject({
      type: 'calendar.event_published',
      version: 1,
      source: 'calendar',
      institutionId: INSTITUTION,
      occurredAt: now.toISOString(),
    });
    expect(env.data.event).toEqual(res.json<{ event: CalendarEvent }>().event);
    expect(env.data.event.provenance?.quote).toBe(provenance.quote);
    expect(env.data.section).toEqual({
      classSectionId: SECTION,
      courseId: COURSE,
      courseName: 'Cálculo I',
      sectionCode: 'T1',
    });
    expect(env.data.previousVersion).toBeNull();
  });

  it('publishes calendar.event_updated with changes on a date change and on cancellation', async () => {
    const created = (await publish()).json<{ event: CalendarEvent }>().event;
    await publish({ eventDate: '2026-11-27', changeReason: 'Prova adiada' });
    const updated = events.published[1] as EventEnvelope<CalendarEventPayload>;
    expect(updated.type).toBe('calendar.event_updated');
    expect(updated.data.previousVersion).toBe(1);
    expect(updated.data.event).toMatchObject({ version: 2, eventDate: '2026-11-27' });
    expect(updated.data.changes.map((c) => [c.field, c.previousValue, c.newValue])).toEqual([
      ['eventDate', '2026-11-20', '2026-11-27'],
    ]);

    await app.inject({
      method: 'POST',
      url: `/v1/calendar-events/${created.id}/cancel`,
      headers: internal,
      payload: { actorId: provenance.confirmedBy, reason: 'Aula cancelada', source: 'professor' },
    });
    const cancelled = events.published[2] as EventEnvelope<CalendarEventPayload>;
    expect(cancelled.type).toBe('calendar.event_updated');
    expect(cancelled.data.event.status).toBe('cancelled');
    expect(cancelled.data.changes[0]?.changeType).toBe('cancellation');
  });

  it('does not publish for an idempotent republish', async () => {
    await publish();
    await publish();
    expect(events.published).toHaveLength(1);
  });

  it('the HTTP publisher posts the envelope to the bus with the internal token and never throws', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const ok = new HttpEventBusPublisher(
      'http://bus:8080/',
      { warn: () => undefined },
      {
        internalToken: 'secret',
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push({ url: String(url), init });
          return new Response(null, { status: 204 });
        }) as typeof fetch,
      },
    );
    const env = {
      eventId: randomUUID(),
      type: 'calendar.event_published',
      version: 1 as const,
      occurredAt: now.toISOString(),
      source: 'calendar' as const,
      institutionId: INSTITUTION,
      data: {},
    };
    await ok.publish(env);
    expect(calls[0]?.url).toBe('http://bus:8080/v1/topics/calendar.event_published:publish');
    expect((calls[0]?.init?.headers as Record<string, string>)['x-internal-token']).toBe('secret');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(env);

    const warnings: unknown[] = [];
    const down = new HttpEventBusPublisher(
      'http://bus',
      { warn: (o) => warnings.push(o) },
      {
        fetch: (async () => {
          throw new Error('ECONNREFUSED');
        }) as typeof fetch,
      },
    );
    await expect(down.publish(env)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});

describe('optimistic concurrency', () => {
  it('rejects a stale version', async () => {
    const created = (await publish()).json<{ event: CalendarEvent }>().event;
    await expect(
      repository.updateEventWithChanges({ ...created, version: 2 }, [], 0),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });
});

describe('internal token (§4)', () => {
  it('protects sync endpoints', async () => {
    const payload = {
      sections: [{ classSectionId: randomUUID(), institutionId: INSTITUTION, courseId: COURSE }],
    };
    expect((await app.inject({ method: 'POST', url: '/v1/sections', payload })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/sections',
          headers: { 'x-internal-token': 'nope' },
          payload,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/sections', headers: internal, payload }))
        .statusCode,
    ).toBe(200);
    for (const url of ['/v1/enrollments/bulk', '/v1/non-teaching-days', '/v1/terms']) {
      expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
    }
  });
});

describe('student routes require identity JWTs (§4)', () => {
  const list = (studentId: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/v1/students/${studentId}/calendar-events`, headers });

  it('lets the student read their own calendar only', async () => {
    await publish();
    const own = await list(STUDENT, auth(token()));
    expect(own.statusCode).toBe(200);
    expect(own.json<{ total: number }>().total).toBe(1);
    expect((await list(OTHER_STUDENT, auth(token()))).statusCode).toBe(403);
    expect((await list(STUDENT)).statusCode).toBe(401);
  });

  it('rejects expired, tampered and foreign-key tokens', async () => {
    const t = token();
    now = new Date(now.getTime() + 16 * 60_000);
    const expired = await list(STUDENT, auth(t));
    expect(expired.statusCode).toBe(401);
    expect(expired.json<{ error: { code: string } }>().error.code).toBe('token_expired');
    now = new Date('2026-11-04T22:30:00.000Z');
    const [h, , s] = token().split('.');
    const forged = `${h}.${b64({ pid: OTHER_STUDENT, role: 'admin' })}.${s}`;
    expect((await list(OTHER_STUDENT, auth(forged))).statusCode).toBe(401);
    const other = generateKeyPairSync('ed25519');
    const input = `${b64({ alg: 'EdDSA', typ: 'JWT' })}.${token().split('.')[1]}`;
    const foreign = `${input}.${sign(null, Buffer.from(input), other.privateKey).toString('base64url')}`;
    expect((await list(STUDENT, auth(foreign))).statusCode).toBe(401);
  });

  it('allows coordinators/admins of the student institution; denies other institutions and professors', async () => {
    expect(
      (await list(STUDENT, auth(token({ role: 'coordinator', pid: undefined })))).statusCode,
    ).toBe(200);
    expect((await list(STUDENT, auth(token({ role: 'admin', pid: undefined })))).statusCode).toBe(
      200,
    );
    expect(
      (await list(STUDENT, auth(token({ role: 'admin', pid: undefined, inst: OTHER_INSTITUTION }))))
        .statusCode,
    ).toBe(403);
    expect(
      (await list(STUDENT, auth(token({ role: 'professor', pid: randomUUID() })))).statusCode,
    ).toBe(403);
  });

  it('protects feed-token issuance; the ICS feed itself stays token-in-URL', async () => {
    const url = `/v1/students/${STUDENT}/calendar-feed-token`;
    expect((await app.inject({ method: 'POST', url })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url, headers: auth(token({ pid: OTHER_STUDENT })) }))
        .statusCode,
    ).toBe(403);
    const issued = await app.inject({ method: 'POST', url, headers: auth(token()) });
    expect(issued.statusCode).toBe(201);
    const feed = await app.inject({
      method: 'GET',
      url: issued.json<{ feedPath: string }>().feedPath,
    });
    expect(feed.statusCode).toBe(200);
    expect(feed.body).toContain('BEGIN:VCALENDAR');
  });
});

describe('DSR handler (§5)', () => {
  const dsr = (type: string, body: Record<string, unknown>, headers = internal) =>
    app.inject({ method: 'POST', url: `/internal/v1/dsr/${type}`, headers, payload: body });
  const body = (subjectType = 'student', subjectId = STUDENT) => ({
    subjectType,
    subjectId,
    requestId: randomUUID(),
    institutionId: INSTITUTION,
  });

  it('deletes the feed token and revokes the feed', async () => {
    const issued = await app.inject({
      method: 'POST',
      url: `/v1/students/${STUDENT}/calendar-feed-token`,
      headers: auth(token()),
    });
    const feedPath = issued.json<{ feedPath: string }>().feedPath;
    const access = await dsr('access', body());
    expect(access.json()).toMatchObject({
      service: 'calendar',
      status: 'completed',
      items: { calendarFeed: { active: true } },
    });

    const deletion = await dsr('deletion', body());
    expect(deletion.json()).toEqual({
      service: 'calendar',
      status: 'completed',
      items: { feedTokensRemoved: 1, externalConnectionsRemoved: 0, remoteCalendarsDeleted: 0 },
    });
    expect((await app.inject({ method: 'GET', url: feedPath })).statusCode).toBe(401);
    // Idempotent: a retry reports nothing left to remove.
    expect((await dsr('deletion', body())).json()).toEqual({
      service: 'calendar',
      status: 'completed',
      items: { feedTokensRemoved: 0, externalConnectionsRemoved: 0, remoteCalendarsDeleted: 0 },
    });
  });

  it('is not applicable to non-student subjects and to corrections', async () => {
    expect((await dsr('deletion', body('user', randomUUID()))).json()).toMatchObject({
      status: 'not_applicable',
    });
    expect((await dsr('correction', body())).json()).toMatchObject({ status: 'not_applicable' });
  });

  it('requires the internal token and validates input', async () => {
    expect((await dsr('deletion', body(), {} as typeof internal)).statusCode).toBe(401);
    expect((await dsr('portability', body())).statusCode).toBe(400);
    expect((await dsr('deletion', { subjectType: 'student' })).statusCode).toBe(400);
  });
});

describe('calendar writes require the internal token or a staff JWT', () => {
  const conflicts = (headers: Record<string, string>, institutionId = INSTITUTION) =>
    app.inject({
      method: 'POST',
      url: '/v1/conflicts/check',
      headers,
      payload: {
        institutionId,
        classSectionId: SECTION,
        type: 'examination',
        eventDate: '2026-11-20',
      },
    });

  it('publishing: internal token or coordinator/admin of the institution', async () => {
    expect((await publish({}, {})).statusCode).toBe(401);
    expect((await publish({}, { 'x-internal-token': 'wrong' })).statusCode).toBe(401);
    expect((await publish({}, auth(token()))).statusCode).toBe(403);
    expect(
      (await publish({}, auth(token({ role: 'professor', pid: randomUUID() })))).statusCode,
    ).toBe(403);
    expect(
      (
        await publish(
          {},
          auth(token({ role: 'group_executive', pid: undefined, hc: randomUUID() })),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await publish({}, auth(token({ role: 'admin', pid: undefined, inst: OTHER_INSTITUTION }))))
        .statusCode,
    ).toBe(403);
    expect(
      (await publish({}, auth(token({ role: 'coordinator', pid: undefined })))).statusCode,
    ).toBe(201);
    expect((await publish({ eventDate: '2026-11-21' }, internal)).statusCode).toBe(200);
  });

  it('cancelling checks the event institution', async () => {
    const created = (await publish()).json<{ event: CalendarEvent }>().event;
    const cancel = (headers: Record<string, string>, id = created.id) =>
      app.inject({
        method: 'POST',
        url: `/v1/calendar-events/${id}/cancel`,
        headers,
        payload: { actorId: randomUUID(), reason: 'Cancelada' },
      });
    expect((await cancel({})).statusCode).toBe(401);
    expect(
      (await cancel(auth(token({ role: 'admin', pid: undefined, inst: OTHER_INSTITUTION }))))
        .statusCode,
    ).toBe(403);
    expect(
      (await cancel(auth(token({ role: 'admin', pid: undefined })), randomUUID())).statusCode,
    ).toBe(403);
    expect((await cancel(internal, randomUUID())).statusCode).toBe(404);
    expect((await cancel(auth(token({ role: 'admin', pid: undefined })))).statusCode).toBe(200);
  });

  it('conflict checks: internal token or staff of the institution', async () => {
    expect((await conflicts({})).statusCode).toBe(401);
    expect((await conflicts(auth(token()))).statusCode).toBe(403);
    expect(
      (await conflicts(auth(token({ role: 'coordinator', pid: undefined })), OTHER_INSTITUTION))
        .statusCode,
    ).toBe(403);
    expect((await conflicts(auth(token({ role: 'coordinator', pid: undefined })))).statusCode).toBe(
      200,
    );
    expect((await conflicts(internal)).statusCode).toBe(200);
  });

  it('student calendars stay closed to group executives', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/students/${STUDENT}/calendar-events`,
      headers: auth(token({ role: 'group_executive', pid: undefined, hc: randomUUID() })),
    });
    expect(res.statusCode).toBe(403);
  });
});
