import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import type { CalendarEvent } from './domain.js';
import { InMemoryEventPublisher, type EventEnvelope } from './events.js';
import { TokenCipher } from './external/crypto.js';
import { GoogleCalendarProvider, MicrosoftCalendarProvider } from './external/providers.js';
import { InMemoryExternalCalendarRepository } from './external/repository.js';
import { createAccessTokenVerifier, type AccessTokenClaims } from './jwt-verify.js';
import { FakeCalendarProvider } from './test/fake-calendar-providers.js';

const INSTITUTION = randomUUID();
const COURSE = randomUUID();
const SECTION = randomUUID();
const STUDENT = randomUUID();
const OTHER = randomUUID();
const INTERNAL = 'ext-internal';
const internal = { 'x-internal-token': INTERNAL };

const keys = generateKeyPairSync('ed25519');
const b64 = (v: object): string => Buffer.from(JSON.stringify(v)).toString('base64url');
let now = new Date('2026-11-04T22:30:00.000Z');

function bearer(pid = STUDENT): Record<string, string> {
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
    pid,
  };
  const input = `${b64({ alg: 'EdDSA', typ: 'JWT' })}.${b64(claims)}`;
  return {
    authorization: `Bearer ${input}.${sign(null, Buffer.from(input), keys.privateKey).toString('base64url')}`,
  };
}

let app: FastifyInstance;
let google: FakeCalendarProvider;
let microsoft: FakeCalendarProvider;
let repo: InMemoryExternalCalendarRepository;
let events: InMemoryEventPublisher;
type Json = Record<string, unknown>;

beforeEach(async () => {
  now = new Date('2026-11-04T22:30:00.000Z');
  google = new FakeCalendarProvider('google');
  microsoft = new FakeCalendarProvider('microsoft');
  repo = new InMemoryExternalCalendarRepository();
  events = new InMemoryEventPublisher();
  const clockNow = (): Date => now;
  app = buildApp({
    clock: { now: clockNow },
    events,
    internalToken: INTERNAL,
    verifyAccessToken: createAccessTokenVerifier({ getKey: () => keys.publicKey, now: clockNow }),
    external: {
      repo,
      cipher: new TokenCipher(Buffer.alloc(32, 9)),
      redirectBaseUrl: 'https://api.ci.example',
      providers: {
        google: new GoogleCalendarProvider({
          clientId: 'g-client',
          clientSecret: 'g-secret',
          fetch: google.fetch,
          now: clockNow,
        }),
        microsoft: new MicrosoftCalendarProvider({
          clientId: 'm-client',
          clientSecret: 'm-secret',
          fetch: microsoft.fetch,
          now: clockNow,
        }),
      },
    },
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
        },
      ],
    },
  });
  await app.inject({
    method: 'POST',
    url: '/v1/enrollments/bulk',
    headers: internal,
    payload: { classSectionId: SECTION, studentIds: [STUDENT, OTHER] },
  });
});

const publish = async (overrides: Json = {}): Promise<CalendarEvent> => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/calendar-events',
    headers: internal,
    payload: {
      institutionId: INSTITUTION,
      courseId: COURSE,
      classSectionId: SECTION,
      type: 'examination',
      title: 'Prova 2',
      eventDate: '2026-11-20',
      eventTime: '19:00',
      isOfficial: true,
      ...overrides,
    },
  });
  if (res.statusCode >= 300) throw new Error(`publish failed: ${res.statusCode} ${res.body}`);
  return res.json<{ event: CalendarEvent }>().event;
};

/** Delivers the last published bus event to the sync handler (as the dev bus would). */
const deliverLast = async (
  format: 'raw' | 'push' = 'raw',
  envelope?: EventEnvelope,
): Promise<Json> => {
  const env = envelope ?? events.published.at(-1);
  const payload =
    format === 'raw'
      ? env
      : {
          message: { data: Buffer.from(JSON.stringify(env)).toString('base64'), messageId: '1' },
          subscription: 's',
        };
  const res = await app.inject({
    method: 'POST',
    url: '/internal/v1/events/calendar',
    headers: internal,
    payload: payload as Json,
  });
  expect(res.statusCode).toBe(200);
  return res.json<Json>();
};

async function connect(
  provider: 'google' | 'microsoft',
  fake: FakeCalendarProvider,
): Promise<Json> {
  const start = await app.inject({
    method: 'POST',
    url: `/v1/students/${STUDENT}/calendar-connections/connect/${provider}`,
    headers: bearer(),
  });
  expect(start.statusCode).toBe(201);
  const { code, state } = fake.consent(start.json<{ authorizationUrl: string }>().authorizationUrl);
  const cb = await app.inject({
    method: 'GET',
    url: `/v1/oauth/${provider}/callback?code=${code}&state=${state}`,
  });
  expect(cb.statusCode).toBe(200);
  return cb.json<Json>();
}

const connectionOf = async (provider: 'google' | 'microsoft') =>
  (await repo.listConnections({ studentId: STUDENT })).find((c) => c.provider === provider);

describe('connecting (OAuth 2.0 + PKCE + state)', () => {
  it('builds the Google authorization URL with PKCE S256, state, offline access and the narrow scope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/students/${STUDENT}/calendar-connections/connect/google`,
      headers: bearer(),
    });
    const url = new URL(res.json<{ authorizationUrl: string }>().authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'g-client',
      redirect_uri: 'https://api.ci.example/v1/oauth/google/callback',
      scope: 'https://www.googleapis.com/auth/calendar.app.created',
      code_challenge_method: 'S256',
      access_type: 'offline',
    });
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.json<Json>()['state']).toBe(url.searchParams.get('state'));
  });

  it('requires the student JWT on connection routes', async () => {
    const url = `/v1/students/${STUDENT}/calendar-connections`;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url, headers: bearer(OTHER) })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: `${url}/connect/google`, headers: bearer(OTHER) }))
        .statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'GET', url, headers: bearer() })).json()).toEqual({
      items: [],
    });
  });

  it('completes the flow: dedicated calendar, sealed tokens, initial sync of existing events', async () => {
    const existing = await publish();
    const result = await connect('google', google);
    expect(result['connection']).toMatchObject({
      provider: 'google',
      status: 'active',
      studentId: STUDENT,
    });
    expect(result['stats']).toMatchObject({ upserted: 1 });
    expect([...google.calendars.values()][0]).toEqual({
      summary: 'Classroom Intelligence',
      timeZone: 'America/Sao_Paulo',
    });

    const conn = await connectionOf('google');
    const remote = google.eventsIn(conn?.remoteCalendarId ?? '');
    expect(remote).toHaveLength(1);
    expect(remote[0]?.id).toBe(GoogleCalendarProvider.eventId(`${conn?.id}:${existing.id}`));
    expect(remote[0]?.body).toMatchObject({
      summary: 'Prova 2 · Cálculo I',
      start: { dateTime: '2026-11-20T19:00:00', timeZone: 'America/Sao_Paulo' },
      end: { dateTime: '2026-11-20T21:00:00', timeZone: 'America/Sao_Paulo' },
    });
    // Tokens are sealed: no plaintext token in the stored ciphertext.
    const sealed = conn?.tokenCiphertext?.toString('latin1') ?? '';
    expect(sealed).not.toContain('google-rt');
    expect(sealed).not.toContain('google-at');
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/students/${STUDENT}/calendar-connections`,
      headers: bearer(),
    });
    expect(JSON.stringify(listed.json())).not.toMatch(/token/i);
  });

  it('rejects reused, foreign, expired or denied callbacks', async () => {
    const start = await app.inject({
      method: 'POST',
      url: `/v1/students/${STUDENT}/calendar-connections/connect/google`,
      headers: bearer(),
    });
    const { code, state } = google.consent(
      start.json<{ authorizationUrl: string }>().authorizationUrl,
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/oauth/microsoft/callback?code=${code}&state=${state}`,
        })
      ).json<Json>(),
    ).toMatchObject({
      error: { code: 'invalid_state' },
    });
    // the state was consumed by the wrong-provider attempt
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/oauth/google/callback?code=${code}&state=${state}`,
        })
      ).statusCode,
    ).toBe(400);

    const again = await app.inject({
      method: 'POST',
      url: `/v1/students/${STUDENT}/calendar-connections/connect/google`,
      headers: bearer(),
    });
    const second = google.consent(again.json<{ authorizationUrl: string }>().authorizationUrl);
    now = new Date(now.getTime() + 11 * 60_000);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/oauth/google/callback?code=${second.code}&state=${second.state}`,
        })
      ).json<Json>(),
    ).toMatchObject({
      error: { code: 'state_expired' },
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/oauth/google/callback?error=access_denied&state=x`,
        })
      ).statusCode,
    ).toBe(400);
    expect(await repo.listConnections({})).toHaveLength(0);
  });

  it('returns 404 for a provider that is not configured', async () => {
    const bare = buildApp({
      external: {
        repo: new InMemoryExternalCalendarRepository(),
        providers: {},
        cipher: TokenCipher.ephemeral(),
        redirectBaseUrl: 'http://x',
      },
    });
    const res = await bare.inject({
      method: 'POST',
      url: `/v1/students/${STUDENT}/calendar-connections/connect/google`,
    });
    expect(res.json<Json>()).toMatchObject({ error: { code: 'provider_not_configured' } });
  });
});

describe('synchronisation', () => {
  it('creates, patches, skips and deletes remote events from calendar.event_* (idempotent by eventId)', async () => {
    await connect('google', google);
    const conn = await connectionOf('google');
    const calendarId = conn?.remoteCalendarId ?? '';

    const source = {
      extractedEventId: randomUUID(),
      provenance: {
        recordingSessionId: randomUUID(),
        transcriptId: randomUUID(),
        segmentIndex: 3,
        startMs: 1000,
        endMs: 2000,
        quote: 'o seminário será dia 20',
        confirmedBy: randomUUID(),
        confirmedAt: '2026-11-04T22:00:00.000Z',
      },
    };
    const created = await publish({
      ...source,
      title: 'Seminário',
      type: 'presentation',
      eventTime: undefined,
    });
    expect(await deliverLast('push')).toMatchObject({ processed: true, upserted: 1 });
    expect(google.eventsIn(calendarId)[0]?.body).toMatchObject({
      start: { date: '2026-11-20' },
      end: { date: '2026-11-21' },
    });
    const posts = google.calls('POST', '/events').length;
    expect(await deliverLast('raw')).toEqual({ duplicate: true });
    expect(google.calls('POST', '/events').length).toBe(posts);

    await publish({
      ...source,
      title: 'Seminário',
      type: 'presentation',
      eventTime: undefined,
      eventDate: '2026-11-27',
    });
    expect(events.published.at(-1)?.type).toBe('calendar.event_updated');
    expect(await deliverLast()).toMatchObject({ upserted: 1 });
    const remote = google.eventsIn(calendarId);
    expect(remote).toHaveLength(1);
    expect(remote[0]?.body).toMatchObject({ start: { date: '2026-11-27' } });
    expect(google.calls('PATCH', '/events/').length).toBe(1);

    // Same version delivered again under a new envelope id → skipped, no API call.
    const replay = { ...(events.published.at(-1) as EventEnvelope), eventId: randomUUID() };
    expect(await deliverLast('raw', replay)).toMatchObject({ skipped: 1, upserted: 0 });

    await app.inject({
      method: 'POST',
      url: `/v1/calendar-events/${created.id}/cancel`,
      headers: internal,
      payload: { actorId: randomUUID(), reason: 'cancelado' },
    });
    expect(await deliverLast()).toMatchObject({ deleted: 1 });
    expect(google.eventsIn(calendarId)).toHaveLength(0);
    expect(await repo.listLinks(conn?.id ?? '')).toHaveLength(0);
  });

  it('refreshes expired access tokens and retries once after a 401', async () => {
    await connect('google', google);
    now = new Date(now.getTime() + 2 * 3600_000);
    await publish({ title: 'Quiz', type: 'quiz' });
    expect(await deliverLast()).toMatchObject({ upserted: 1 });
    expect(google.calls('POST', '/token').length).toBe(2); // exchange + refresh

    google.invalidateAccessTokens();
    await publish({ title: 'Quiz 2', type: 'quiz', eventDate: '2026-11-25' });
    expect(await deliverLast()).toMatchObject({ upserted: 1 });
    expect((await connectionOf('google'))?.status).toBe('active');
  });

  it('marks the connection broken on invalid_grant and recovers on reconnect', async () => {
    await connect('google', google);
    google.revokeGrant();
    now = new Date(now.getTime() + 2 * 3600_000);
    await publish({ title: 'Prova final' });
    expect(await deliverLast()).toMatchObject({ broken: 1, upserted: 0 });
    const broken = await connectionOf('google');
    expect(broken).toMatchObject({
      status: 'broken',
      lastError: 'invalid_grant',
      tokenCiphertext: null,
    });
    // No further calls against a dead grant.
    const calls = google.requests.length;
    await publish({ title: 'Prova final', eventDate: '2026-12-02' });
    expect(await deliverLast()).toMatchObject({ upserted: 0, broken: 0 });
    expect(google.requests.length).toBe(calls);

    // Reconnecting reuses the dedicated calendar and catches up.
    const reconnected = await connect('google', google);
    expect(reconnected['connection']).toMatchObject({
      status: 'active',
      remoteCalendarId: broken?.remoteCalendarId,
    });
  });

  it('Google inserts are idempotent: a retried insert after a lost response patches instead of duplicating', async () => {
    const provider = new GoogleCalendarProvider({
      clientId: 'g',
      clientSecret: 's',
      fetch: google.fetch,
    });
    const tokens = await (async () => {
      const res = await google.fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: 'grant_type=refresh_token&refresh_token=x',
      });
      return (await res.json()) as { access_token: string };
    })();
    const calendarId = await provider.createCalendar(
      tokens.access_token,
      'Classroom Intelligence',
      'America/Sao_Paulo',
    );
    const event = {
      idempotencyKey: 'k',
      title: 'A',
      description: 'd',
      timezone: 'America/Sao_Paulo',
      date: '2026-11-20',
      startTime: '10:00',
      durationMinutes: 60,
    };
    const first = await provider.upsertEvent(tokens.access_token, calendarId, null, event);
    const second = await provider.upsertEvent(tokens.access_token, calendarId, null, {
      ...event,
      title: 'B',
    });
    expect(second).toBe(first);
    expect(google.eventsIn(calendarId)).toHaveLength(1);
    expect(google.eventsIn(calendarId)[0]?.body['summary']).toBe('B');
  });

  it('Microsoft 365: Graph calendar + events with transactionId; all-day and cancellation', async () => {
    await publish({ title: 'Entrega do projeto', type: 'project', eventTime: undefined });
    await connect('microsoft', microsoft);
    const conn = await connectionOf('microsoft');
    expect(microsoft.calls('POST', '/v1.0/me/calendars').length).toBeGreaterThanOrEqual(1);
    const remote = microsoft.eventsIn(conn?.remoteCalendarId ?? '');
    expect(remote).toHaveLength(1);
    expect(remote[0]?.body).toMatchObject({
      subject: 'Entrega do projeto · Cálculo I',
      isAllDay: true,
      start: { dateTime: '2026-11-20T00:00:00' },
      end: { dateTime: '2026-11-21T00:00:00' },
    });
    expect(String(remote[0]?.body['transactionId'])).toHaveLength(36);
    expect(new URL(microsoft.requests[0]?.url ?? '').hostname).toBe('login.microsoftonline.com');
  });

  it('nightly reconcile removes events the student can no longer see (unenrolled)', async () => {
    await publish();
    await connect('google', google);
    const conn = await connectionOf('google');
    expect(google.eventsIn(conn?.remoteCalendarId ?? '')).toHaveLength(1);
    await app.inject({
      method: 'POST',
      url: '/v1/enrollments/bulk',
      headers: internal,
      payload: { classSectionId: SECTION, studentIds: [OTHER], mode: 'replace' },
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/v1/external-calendars/reconcile',
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    const res = await app.inject({
      method: 'POST',
      url: '/internal/v1/external-calendars/reconcile',
      headers: internal,
      payload: {},
    });
    expect(res.json()).toMatchObject({ connections: 1, deleted: 1 });
    expect(google.eventsIn(conn?.remoteCalendarId ?? '')).toHaveLength(0);
  });
});

describe('disconnect and DSR', () => {
  it('a student can disconnect only their own connection; the remote calendar is deleted and the grant revoked', async () => {
    await connect('google', google);
    const conn = await connectionOf('google');
    const url = `/v1/students/${OTHER}/calendar-connections/${conn?.id}`;
    expect((await app.inject({ method: 'DELETE', url, headers: bearer(OTHER) })).statusCode).toBe(
      404,
    );
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/students/${STUDENT}/calendar-connections/${conn?.id}`,
      headers: bearer(),
    });
    expect(res.json()).toEqual({ deleted: true, remoteCalendarDeleted: true });
    expect(google.calendars.size).toBe(0);
    expect(google.revoked).toEqual(['google-rt']);
    expect(await repo.listConnections({})).toHaveLength(0);
  });

  it('DSR access lists connections; deletion removes connections and remote events', async () => {
    await publish();
    await connect('google', google);
    await connect('microsoft', microsoft);
    const dsr = (type: string) =>
      app.inject({
        method: 'POST',
        url: `/internal/v1/dsr/${type}`,
        headers: internal,
        payload: {
          subjectType: 'student',
          subjectId: STUDENT,
          requestId: randomUUID(),
          institutionId: INSTITUTION,
        },
      });
    const access = (await dsr('access')).json<{ items: { externalCalendarConnections: Json[] } }>();
    expect(access.items.externalCalendarConnections.map((c) => c['provider']).sort()).toEqual([
      'google',
      'microsoft',
    ]);
    expect(JSON.stringify(access)).not.toMatch(/-at-|-rt/);

    const deletion = await dsr('deletion');
    expect(deletion.json()).toMatchObject({
      status: 'completed',
      items: { externalConnectionsRemoved: 2, remoteCalendarsDeleted: 2 },
    });
    expect(google.events.size + microsoft.events.size).toBe(0);
    expect(await repo.listConnections({ studentId: STUDENT })).toHaveLength(0);
  });
});

describe('token cipher', () => {
  it('binds ciphertexts to the connection and the key', () => {
    const cipher = new TokenCipher(Buffer.alloc(32, 1));
    const sealed = cipher.seal('conn-1', 'secret');
    expect(cipher.open('conn-1', sealed)).toBe('secret');
    expect(() => cipher.open('conn-2', sealed)).toThrow();
    expect(() => new TokenCipher(Buffer.alloc(32, 2)).open('conn-1', sealed)).toThrow();
    expect(() => new TokenCipher(Buffer.alloc(16))).toThrow();
    expect(
      TokenCipher.fromEnv({
        CALENDAR_TOKEN_KEY_REF: 'env:K',
        K: Buffer.alloc(32, 3).toString('base64'),
      }),
    ).toBeDefined();
    expect(TokenCipher.fromEnv({})).toBeUndefined();
  });
});
