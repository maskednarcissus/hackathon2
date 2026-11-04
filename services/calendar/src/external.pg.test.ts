/** Phase 6 §6.9 external calendars against PostgreSQL (skipped unless TEST_DATABASE_URL is set). */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import type { CalendarEvent } from './domain.js';
import { InMemoryEventPublisher } from './events.js';
import { TokenCipher } from './external/crypto.js';
import { GoogleCalendarProvider } from './external/providers.js';
import { PgExternalCalendarRepository } from './external/repository.pg.js';
import { PgCalendarRepository, PgFeedTokenRepository } from './repository.pg.js';
import { FakeCalendarProvider } from './test/fake-calendar-providers.js';
import {
  createTestDatabase,
  seedAcademic,
  TEST_DATABASE_URL,
  type AcademicSeed,
  type TestDatabase,
} from './test/pg.js';

type Json = Record<string, unknown>;

describe.skipIf(!TEST_DATABASE_URL)('external calendars on PostgreSQL', () => {
  let db: TestDatabase;
  let seed: AcademicSeed;
  let app: FastifyInstance;
  let google: FakeCalendarProvider;
  const events = new InMemoryEventPublisher();
  let now = new Date('2026-11-04T22:30:00.000Z');
  let student = '';

  beforeAll(async () => {
    db = await createTestDatabase(TEST_DATABASE_URL ?? '');
    seed = await seedAcademic(db.pool, 2);
    student = seed.studentIds[0] ?? '';
    google = new FakeCalendarProvider('google');
    const clockNow = (): Date => now;
    app = buildApp({
      repository: new PgCalendarRepository(db.pool),
      feedTokens: new PgFeedTokenRepository(db.pool),
      events,
      clock: { now: clockNow },
      external: {
        repo: new PgExternalCalendarRepository(db.pool),
        cipher: new TokenCipher(Buffer.alloc(32, 5)),
        redirectBaseUrl: 'https://api.ci.example',
        providers: {
          google: new GoogleCalendarProvider({
            clientId: 'g',
            clientSecret: 's',
            fetch: google.fetch,
            now: clockNow,
          }),
        },
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/sections',
      payload: {
        sections: [
          {
            classSectionId: seed.sectionIds[0],
            institutionId: seed.institutionId,
            courseId: seed.courseIds[0],
            courseName: 'Cálculo I',
          },
        ],
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/enrollments/bulk',
      payload: { classSectionId: seed.sectionIds[0], studentIds: seed.studentIds },
    });
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  const publish = async (extra: Json = {}): Promise<CalendarEvent> =>
    (
      await app.inject({
        method: 'POST',
        url: '/v1/calendar-events',
        payload: {
          institutionId: seed.institutionId,
          courseId: seed.courseIds[0],
          classSectionId: seed.sectionIds[0],
          type: 'examination',
          title: 'Prova',
          eventDate: '2026-11-20',
          eventTime: '19:00',
          ...extra,
        },
      })
    ).json<{ event: CalendarEvent }>().event;

  const deliver = async (): Promise<Json> =>
    (
      await app.inject({
        method: 'POST',
        url: '/internal/v1/events/calendar',
        payload: events.published.at(-1) as unknown as Json,
      })
    ).json<Json>();

  const connection = async (): Promise<Json | undefined> =>
    (
      await db.pool.query('SELECT * FROM external_calendar_connections WHERE student_id = $1', [
        student,
      ])
    ).rows[0] as Json | undefined;

  it('connects, stores sealed tokens and consumes the OAuth state', async () => {
    const start = await app.inject({
      method: 'POST',
      url: `/v1/students/${student}/calendar-connections/connect/google`,
    });
    const { code, state } = google.consent(
      start.json<{ authorizationUrl: string }>().authorizationUrl,
    );
    expect(
      (await db.pool.query('SELECT count(*)::int AS n FROM external_calendar_oauth_states'))
        .rows[0],
    ).toEqual({ n: 1 });
    const cb = await app.inject({
      method: 'GET',
      url: `/v1/oauth/google/callback?code=${code}&state=${state}`,
    });
    expect(cb.json<Json>()['connection']).toMatchObject({ status: 'active' });
    expect(
      (await db.pool.query('SELECT count(*)::int AS n FROM external_calendar_oauth_states'))
        .rows[0],
    ).toEqual({ n: 0 });
    const row = await connection();
    expect(row?.['status']).toBe('active');
    const sealed = (row?.['token_ciphertext'] as Buffer).toString('latin1');
    expect(sealed).not.toContain('google-at');
    expect(sealed).not.toContain('google-rt');
  });

  it('syncs bus events idempotently with links and processed_events', async () => {
    const event = await publish();
    expect(await deliver()).toMatchObject({ processed: true, upserted: 1 });
    expect(await deliver()).toEqual({ duplicate: true });
    const links = await db.pool.query(
      'SELECT external_event_id, synced_version FROM external_calendar_event_links WHERE calendar_event_id = $1',
      [event.id],
    );
    expect(links.rows).toHaveLength(1);
    expect(links.rows[0]).toMatchObject({ synced_version: 1 });
    const processed = await db.pool.query(
      "SELECT count(*)::int AS n FROM processed_events WHERE consumer = 'calendar-external-sync'",
    );
    expect(processed.rows[0]).toEqual({ n: 1 });

    await app.inject({
      method: 'POST',
      url: `/v1/calendar-events/${event.id}/cancel`,
      payload: { actorId: randomUUID(), reason: 'cancelada' },
    });
    expect(await deliver()).toMatchObject({ deleted: 1 });
    expect(
      (await db.pool.query('SELECT count(*)::int AS n FROM external_calendar_event_links')).rows[0],
    ).toEqual({ n: 0 });
  });

  it('a broken connection never keeps tokens (checked by the database too)', async () => {
    const id = String((await connection())?.['id']);
    await expect(
      db.pool.query("UPDATE external_calendar_connections SET status = 'broken' WHERE id = $1", [
        id,
      ]),
    ).rejects.toThrow(/ck_external_calendar_broken_no_tokens/);
    google.revokeGrant();
    now = new Date(now.getTime() + 2 * 3600_000);
    await publish({ title: 'Prova final', eventDate: '2026-12-01' });
    expect(await deliver()).toMatchObject({ broken: 1 });
    const row = await connection();
    expect(row).toMatchObject({
      status: 'broken',
      last_error: 'invalid_grant',
      token_ciphertext: null,
    });
  });

  it('DSR deletion removes the student connections (links cascade)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/v1/dsr/deletion',
      payload: {
        subjectType: 'student',
        subjectId: student,
        requestId: randomUUID(),
        institutionId: seed.institutionId,
      },
    });
    expect(res.json()).toMatchObject({
      status: 'completed',
      items: { externalConnectionsRemoved: 1 },
    });
    expect(await connection()).toBeUndefined();
  });
});
