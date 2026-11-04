/**
 * Behavioural scenarios against PostgreSQL (skipped unless TEST_DATABASE_URL is set).
 * Fresh database per file with every migration (V*.sql + pending/*.sql) applied.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import type { CalendarEvent, CalendarEventChange, Conflict } from './domain.js';
import { InMemoryEventPublisher } from './events.js';
import { VersionConflictError } from './repository.js';
import { PgCalendarRepository, PgFeedTokenRepository } from './repository.pg.js';
import {
  createTestDatabase,
  seedAcademic,
  TEST_DATABASE_URL,
  type AcademicSeed,
  type TestDatabase,
} from './test/pg.js';

interface PublishBody {
  event: CalendarEvent;
  created: boolean;
  changes: CalendarEventChange[];
  conflicts: Conflict[];
}

describe.skipIf(!TEST_DATABASE_URL)('calendar on PostgreSQL', () => {
  let db: TestDatabase;
  let seed: AcademicSeed;
  let app: FastifyInstance;
  let events: InMemoryEventPublisher;
  const now = new Date('2026-11-04T22:30:00.000Z');

  const provenance = (quote = 'nossa segunda prova será no dia 20 de novembro') => ({
    recordingSessionId: randomUUID(),
    transcriptId: randomUUID(),
    scheduledClassId: randomUUID(),
    segmentIndex: 42,
    startMs: 2_461_000,
    endMs: 2_468_500,
    quote,
    confirmedBy: randomUUID(),
    confirmedAt: '2026-11-04T22:00:00.000Z',
  });

  const publish = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/v1/calendar-events', payload: body });

  const baseEvent = (
    section: 0 | 1,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    institutionId: seed.institutionId,
    courseId: seed.courseIds[section],
    classSectionId: seed.sectionIds[section],
    type: 'examination',
    title: 'Prova 2',
    eventDate: '2026-11-20',
    eventTime: '19:00',
    isOfficial: true,
    ...extra,
  });

  beforeAll(async () => {
    db = await createTestDatabase(TEST_DATABASE_URL ?? '');
    seed = await seedAcademic(db.pool, 4);
    events = new InMemoryEventPublisher();
    app = buildApp({
      repository: new PgCalendarRepository(db.pool),
      feedTokens: new PgFeedTokenRepository(db.pool),
      events,
      clock: { now: () => now },
    });
    const [s0, s1] = seed.sectionIds;
    const sync = await app.inject({
      method: 'POST',
      url: '/v1/sections',
      payload: {
        sections: [
          {
            classSectionId: s0,
            institutionId: seed.institutionId,
            courseId: seed.courseIds[0],
            courseName: 'Cálculo I',
            sectionCode: 'T1',
          },
          {
            classSectionId: s1,
            institutionId: seed.institutionId,
            courseId: seed.courseIds[1],
            courseName: 'Física I',
            sectionCode: 'T1',
          },
        ],
      },
    });
    expect(sync.statusCode).toBe(200);
    const [a, b, c, d] = seed.studentIds;
    await app.inject({
      method: 'POST',
      url: '/v1/enrollments/bulk',
      payload: { classSectionId: s0, studentIds: [a, b, c] },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/enrollments/bulk',
      payload: { classSectionId: s1, studentIds: [a, d] },
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('replaces enrollments atomically', async () => {
    const [s0] = seed.sectionIds;
    const [a, b, c] = seed.studentIds;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enrollments/bulk',
      payload: { classSectionId: s0, studentIds: [a, b], mode: 'replace' },
    });
    expect(res.json()).toMatchObject({ enrolled: 2 });
    await app.inject({
      method: 'POST',
      url: '/v1/enrollments/bulk',
      payload: { classSectionId: s0, studentIds: [c], mode: 'append' },
    });
    const count = await db.pool.query(
      'SELECT count(*)::int AS n FROM calendar_enrollment_mirror WHERE class_section_id = $1',
      [s0],
    );
    expect(count.rows[0]).toEqual({ n: 3 });
  });

  it('publishes with provenance and reads it back exactly (DATE/TIME untouched)', async () => {
    const extractedEventId = randomUUID();
    const prov = provenance();
    const res = await publish(
      baseEvent(0, { extractedEventId, provenance: prov, description: 'Capítulos 4 a 7' }),
    );
    expect(res.statusCode).toBe(201);
    const created = res.json<PublishBody>().event;
    const fetched = await app.inject({ method: 'GET', url: `/v1/calendar-events/${created.id}` });
    expect(fetched.json<CalendarEvent>()).toMatchObject({
      eventDate: '2026-11-20',
      eventTime: '19:00',
      timezone: 'America/Sao_Paulo',
      status: 'published',
      version: 1,
      extractedEventId,
      provenance: prov,
    });
    expect(events.published.at(-1)?.type).toBe('calendar.event_published');
  });

  it('versions updates with ordered change history and cancellation', async () => {
    const extractedEventId = randomUUID();
    const prov = provenance();
    const created = (
      await publish(
        baseEvent(0, {
          extractedEventId,
          provenance: prov,
          type: 'assignment',
          title: 'Lista 3',
          eventDate: '2026-11-25',
          eventTime: undefined,
        }),
      )
    ).json<PublishBody>().event;
    const moved = await publish(
      baseEvent(0, {
        extractedEventId,
        provenance: prov,
        type: 'assignment',
        title: 'Lista 3',
        eventDate: '2026-11-28',
        eventTime: '23:59',
        changeReason: 'Prazo estendido',
      }),
    );
    expect(moved.statusCode).toBe(200);
    expect(moved.json<PublishBody>().event.version).toBe(2);
    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/calendar-events/${created.id}/cancel`,
      payload: { actorId: prov.confirmedBy, reason: 'Atividade removida' },
    });
    expect(cancel.json<{ event: CalendarEvent }>().event).toMatchObject({
      status: 'cancelled',
      version: 3,
    });

    const history = await app.inject({
      method: 'GET',
      url: `/v1/calendar-events/${created.id}/history?view=student`,
    });
    const items = history.json<{ items: Array<Record<string, unknown>> }>().items;
    expect(items.map((c) => c['field'])).toEqual(['eventDate', 'eventTime', 'status']);
    expect(items.every((c) => !('changedBy' in c))).toBe(true);
    expect(events.published.slice(-2).map((e) => e.type)).toEqual([
      'calendar.event_updated',
      'calendar.event_updated',
    ]);

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/calendar-events?classSectionId=${seed.sectionIds[0]}`,
    });
    expect(listed.json<{ items: CalendarEvent[] }>().items.map((e) => e.id)).not.toContain(
      created.id,
    );
  });

  it('never loses an update: concurrent republishes either apply in order or get 409', async () => {
    const extractedEventId = randomUUID();
    const prov = provenance();
    await publish(baseEvent(1, { extractedEventId, provenance: prov, title: 'P1 Física' }));
    const results = await Promise.all(
      ['2026-11-21', '2026-11-22', '2026-11-23'].map((eventDate) =>
        publish(
          baseEvent(1, { extractedEventId, provenance: prov, title: 'P1 Física', eventDate }),
        ),
      ),
    );
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
    const applied = statuses.filter((s) => s === 200).length;
    const stored = await db.pool.query(
      'SELECT version FROM calendar_events WHERE extracted_event_id = $1',
      [extractedEventId],
    );
    expect(stored.rows[0]).toEqual({ version: 1 + applied });
    const changes = await db.pool.query(
      'SELECT count(*)::int AS n FROM calendar_event_changes c JOIN calendar_events e ON e.id = c.calendar_event_id WHERE e.extracted_event_id = $1',
      [extractedEventId],
    );
    expect(changes.rows[0]).toEqual({ n: applied });
  });

  it('the version check and the write are atomic (stale version → conflict, nothing written)', async () => {
    const repo = new PgCalendarRepository(db.pool);
    const created = (
      await publish(
        baseEvent(1, { title: 'Seminário', type: 'presentation', eventDate: '2026-12-03' }),
      )
    ).json<PublishBody>().event;
    const change: CalendarEventChange = {
      id: randomUUID(),
      calendarEventId: created.id,
      changedAt: now.toISOString(),
      changedBy: null,
      source: 'system',
      changeType: 'description_change',
      field: 'title',
      previousValue: 'Seminário',
      newValue: 'Seminário final',
      reason: null,
    };
    await repo.updateEventWithChanges(
      { ...created, title: 'Seminário final', version: 2 },
      [change],
      1,
    );
    await expect(
      repo.updateEventWithChanges(
        { ...created, title: 'Outro', version: 2 },
        [{ ...change, id: randomUUID() }],
        1,
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect((await repo.getEvent(created.id))?.title).toBe('Seminário final');
    expect(await repo.listChanges(created.id)).toHaveLength(1);
  });

  it('detects conflicts from shared students, non-teaching days and term bounds', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/non-teaching-days',
      payload: {
        institutionId: seed.institutionId,
        days: [{ date: '2026-11-15', description: 'Proclamação da República' }],
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/terms',
      payload: {
        institutionId: seed.institutionId,
        name: '2026.2',
        startDate: '2026-08-01',
        endDate: '2026-12-15',
      },
    });
    await publish(baseEvent(0, { title: 'Prova extra', eventDate: '2026-12-01' }));
    const check = async (body: Record<string, unknown>): Promise<string[]> =>
      (
        await app.inject({
          method: 'POST',
          url: '/v1/conflicts/check',
          payload: { institutionId: seed.institutionId, type: 'examination', ...body },
        })
      )
        .json<{ conflicts: Conflict[] }>()
        .conflicts.map((c) => c.kind);
    expect(await check({ classSectionId: seed.sectionIds[1], eventDate: '2026-12-01' })).toContain(
      'assessment_overlap_shared_students',
    );
    expect(await check({ classSectionId: seed.sectionIds[1], eventDate: '2026-11-15' })).toContain(
      'non_teaching_day',
    );
    expect(await check({ classSectionId: seed.sectionIds[1], eventDate: '2027-01-20' })).toContain(
      'non_teaching_day',
    );
    const days = await app.inject({
      method: 'GET',
      url: `/v1/non-teaching-days?institutionId=${seed.institutionId}`,
    });
    expect(days.json<{ items: Array<{ date: string }> }>().items[0]?.date).toBe('2026-11-15');
  });

  it('serves the student calendar and ICS feed; DSR deletion removes the feed token', async () => {
    const student = seed.studentIds[0] ?? '';
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/students/${student}/calendar-events`,
    });
    const items = listed.json<{ items: Array<Record<string, unknown>> }>().items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i['courseName'] === 'Física I')).toBe(true);

    const issued = await app.inject({
      method: 'POST',
      url: `/v1/students/${student}/calendar-feed-token`,
    });
    const { feedPath, token } = issued.json<{ feedPath: string; token: string }>();
    const stored = await db.pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM calendar_feed_tokens WHERE student_id = $1',
      [student],
    );
    expect(String(stored.rows[0]?.token_hash)).not.toContain(token);
    const feed = await app.inject({ method: 'GET', url: feedPath });
    expect(feed.statusCode).toBe(200);
    expect(feed.body).toContain('BEGIN:VEVENT');

    const rotated = await app.inject({
      method: 'POST',
      url: `/v1/students/${student}/calendar-feed-token`,
    });
    expect(rotated.json()).toMatchObject({ rotated: true });
    expect((await app.inject({ method: 'GET', url: feedPath })).statusCode).toBe(401);

    const dsr = await app.inject({
      method: 'POST',
      url: '/internal/v1/dsr/deletion',
      payload: {
        subjectType: 'student',
        subjectId: student,
        requestId: randomUUID(),
        institutionId: seed.institutionId,
      },
    });
    expect(dsr.json()).toEqual({
      service: 'calendar',
      status: 'completed',
      items: { feedTokensRemoved: 1, externalConnectionsRemoved: 0, remoteCalendarsDeleted: 0 },
    });
    const after = await db.pool.query(
      'SELECT count(*)::int AS n FROM calendar_feed_tokens WHERE student_id = $1',
      [student],
    );
    expect(after.rows[0]).toEqual({ n: 0 });
  });
});
