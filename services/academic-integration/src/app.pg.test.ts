import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import {
  InMemoryAuditClient,
  StaticClassroomDirectory,
  StaticOrganizationClient,
} from './clients.js';
import type { ImportReport, ScheduledClass } from './domain.js';
import { PgAcademicRepository } from './repository.pg.js';
import { loadCanonical } from './sync.js';
import {
  createTestDatabase,
  seedOrganization,
  TEST_DATABASE_URL,
  type TestDatabase,
} from './test/pg.js';

const INST = '11111111-1111-4111-8111-111111111111';
const HOLDING = '10000000-0000-4000-8000-000000000000';
const CAMPUS = '12000000-0000-4000-8000-000000000000';
const ROOM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOM2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const POLICY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    institutionId: INST,
    term: { externalId: '2026-2', name: '2026/2', startDate: '2026-08-03', endDate: '2026-12-11' },
    courses: [
      {
        externalId: 'DIR101',
        code: 'DIR101',
        name: 'Direito Constitucional I',
        discipline: 'law',
        credits: 4,
      },
    ],
    professors: [{ externalId: 'P1', name: 'Ana Souza', email: 'Ana.Souza@uni.example' }],
    students: [
      { externalId: 'S1', name: 'Bruno Lima', email: 'bruno@uni.example' },
      { externalId: 'S2', name: 'Carla Dias', email: 'carla@uni.example' },
    ],
    classSections: [
      {
        externalId: 'DIR101-A',
        courseExternalId: 'DIR101',
        professorExternalId: 'P1',
        sectionCode: 'A',
        schedule: [
          { dayOfWeek: 1, startTime: '19:00', endTime: '20:40', classroomId: ROOM },
          { dayOfWeek: 3, startTime: '19:00', endTime: '20:40', classroomId: ROOM },
        ],
        exceptions: [
          {
            type: 'rescheduled',
            date: '2026-11-04',
            startTime: '08:00',
            endTime: '09:40',
            classroomId: ROOM2,
          },
          {
            type: 'extra',
            date: '2026-11-07',
            startTime: '09:00',
            endTime: '12:00',
            classroomId: ROOM,
          },
        ],
        cancelledDates: ['2026-11-02'],
      },
    ],
    enrollments: [
      { studentExternalId: 'S1', classSectionExternalId: 'DIR101-A' },
      { studentExternalId: 'S2', classSectionExternalId: 'DIR101-A', status: 'withdrawn' },
    ],
    ...overrides,
  };
}

describe.skipIf(!TEST_DATABASE_URL)('academic-integration on Postgres', () => {
  let db: TestDatabase;
  let repo: PgAcademicRepository;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    db = await createTestDatabase(TEST_DATABASE_URL ?? '');
    await seedOrganization(db.pool, {
      holdingId: HOLDING,
      institutionId: INST,
      campusId: CAMPUS,
      classroomIds: [ROOM, ROOM2],
    });
    repo = new PgAcademicRepository(db.pool);
    app = buildApp({
      repository: repo,
      organization: new StaticOrganizationClient(
        new Map([
          [ROOM, { id: POLICY, preRollMinutes: 5, postRollMinutes: 10, recordingEnabled: true }],
        ]),
      ),
      audit: new InMemoryAuditClient(),
      clock: { now: () => new Date('2026-11-04T12:00:00Z') },
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  const list = async (room: string, cancelled = false): Promise<ScheduledClass[]> =>
    (
      await app.inject({
        url: `/v1/scheduled-classes?classroomId=${room}&from=2026-08-01T00:00:00Z&to=2026-12-31T00:00:00Z&includeCancelled=${cancelled}&limit=1000`,
      })
    ).json<{ items: ScheduledClass[] }>().items;

  it('applies an import transactionally and expands the timetable', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/imports', payload: payload() });
    expect(res.statusCode).toBe(201);
    const report = res.json<ImportReport>();
    expect(report.counts.scheduledClasses.created).toBe(39);
    const stored = await app.inject({ url: `/v1/imports/${report.importId}` });
    expect(stored.json<ImportReport>().counts.scheduledClasses.created).toBe(39);
    const all = await list(ROOM, true);
    expect(all.find((c) => c.localDate === '2026-11-02')).toMatchObject({
      status: 'cancelled',
      startsAt: '2026-11-02T22:00:00.000Z',
      institutionId: INST,
    });
    const moved = await list(ROOM2);
    expect(moved.map((c) => [c.localDate, c.startsAt, c.source])).toEqual([
      ['2026-11-04', '2026-11-04T11:00:00.000Z', 'exception'],
    ]);
    const detail = (await app.inject({ url: `/v1/scheduled-classes/${moved[0]?.id ?? ''}` })).json<
      Record<string, unknown>
    >();
    expect(detail).toMatchObject({
      course: { code: 'DIR101' },
      professor: { name: 'Ana Souza' },
      term: { externalId: '2026-2' },
    });
  });

  it('re-imports idempotently with stable ids and cancels removed sessions', async () => {
    const before = await list(ROOM);
    const again = (
      await app.inject({ method: 'POST', url: '/v1/imports', payload: payload() })
    ).json<ImportReport>();
    expect(again.counts.scheduledClasses).toEqual({ created: 0, updated: 0, unchanged: 39 });
    expect(again.counts.students).toEqual({ created: 0, updated: 0, unchanged: 2 });
    const changed = payload();
    const section = (changed['classSections'] as { schedule: unknown[] }[])[0];
    if (!section) throw new Error('fixture');
    section.schedule = [{ dayOfWeek: 1, startTime: '18:30', endTime: '20:40', classroomId: ROOM }];
    const r = (
      await app.inject({ method: 'POST', url: '/v1/imports', payload: changed })
    ).json<ImportReport>();
    expect(r.counts.scheduledClassesCancelled).toBe(18);
    const after = await list(ROOM);
    expect(after.find((c) => c.localDate === '2026-08-03')).toMatchObject({
      id: before.find((c) => c.localDate === '2026-08-03')?.id,
      startsAt: '2026-08-03T21:30:00.000Z',
    });
    expect(after.some((c) => c.localDate === '2026-08-05')).toBe(false);
    await app.inject({ method: 'POST', url: '/v1/imports', payload: payload() }); // restore
  });

  it('rejects imports that reference classrooms organization does not know (nothing applied)', async () => {
    const bad = payload({
      term: {
        externalId: '2027-1',
        name: '2027/1',
        startDate: '2027-02-01',
        endDate: '2027-02-28',
      },
    });
    const sections = bad['classSections'] as Record<string, unknown>[];
    sections[0] = {
      ...sections[0],
      externalId: 'DIR101-Z',
      exceptions: [],
      cancelledDates: [],
      schedule: [
        {
          dayOfWeek: 2,
          startTime: '10:00',
          endTime: '12:00',
          classroomId: '99999999-9999-4999-8999-999999999999',
        },
      ],
    };
    const res = await app.inject({ method: 'POST', url: '/v1/imports', payload: bad });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('unknown_reference');
    const terms = await db.pool.query(
      "SELECT count(*)::int AS n FROM academic_terms WHERE external_id = '2027-1'",
    );
    expect(terms.rows[0]).toEqual({ n: 0 });
  });

  it('identifies classes, serves rosters, recording plans and alert context', async () => {
    const id = await app.inject({
      method: 'POST',
      url: '/v1/class-identification',
      payload: {
        classroomId: ROOM,
        startedAt: '2026-10-26T18:55:00-03:00',
        endedAt: '2026-10-26T20:50:00-03:00',
      },
    });
    expect(id.json()).toMatchObject({
      status: 'matched',
      scheduledClass: { localDate: '2026-10-26', course: { code: 'DIR101' } },
    });
    const sectionId = (await list(ROOM))[0]?.classSectionId ?? '';
    const roster = (await app.inject({ url: `/v1/class-sections/${sectionId}/roster` })).json<{
      studentIds: string[];
      professorIds: string[];
    }>();
    expect(roster.studentIds).toHaveLength(1);
    expect(roster.professorIds).toHaveLength(1);
    const plan = (
      await app.inject({
        url: `/v1/classrooms/${ROOM}/recording-plan?from=2026-11-07T00:00:00Z&to=2026-11-08T00:00:00Z`,
      })
    ).json<{ windows: Record<string, unknown>[] }>();
    expect(plan.windows[0]).toMatchObject({
      recordStartAt: '2026-11-07T11:55:00.000Z',
      recordStopAt: '2026-11-07T15:10:00.000Z',
    });
    const ctx = (
      await app.inject({
        url: `/internal/v1/alert-context?institutionId=${INST}&at=2026-11-04T11:30:00Z`,
      })
    ).json<{ classWindows: { classroomId: string }[] }>();
    expect(ctx.classWindows.map((w) => w.classroomId)).toEqual([ROOM2]);
  });

  it('builds the canonical sync payload from Postgres', async () => {
    const data = await loadCanonical(
      INST,
      repo,
      new StaticClassroomDirectory([
        {
          classroomId: ROOM,
          institutionId: INST,
          campusId: CAMPUS,
          campusName: 'Centro',
          name: 'Sala 1',
        },
      ]),
    );
    expect(data.sections).toEqual([
      expect.objectContaining({
        courseCode: 'DIR101',
        professorName: 'Ana Souza',
        sectionCode: 'A',
        termStartDate: '2026-08-03',
        termEndDate: '2026-12-11',
      }),
    ]);
    expect(data.enrollments.map((e) => [e.status, e.email]).sort()).toEqual([
      ['active', 'bruno@uni.example'],
      ['withdrawn', 'carla@uni.example'],
    ]);
    expect(data.classrooms).toHaveLength(1);
  });
});
