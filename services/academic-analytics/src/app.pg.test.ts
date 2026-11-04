import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgAnalyticsRepository, PgDirectory } from './repository.pg.js';
import {
  C1,
  C2,
  C3,
  coordinator,
  INST,
  internal,
  PROF_A,
  PROGRAM,
  S1,
  setup,
} from './test/fixture.js';
import {
  createTestDatabase,
  seedOrganization,
  TEST_DATABASE_URL,
  type TestDatabase,
} from './test/pg.js';

const HOLDING = '10000000-0000-4000-8000-000000000000';
const TERM = '15000000-0000-4000-8000-000000000000';
const q = (path: string): string => `/v1/institutions/${INST}${path}`;

describe.skipIf(!TEST_DATABASE_URL)('academic-analytics on Postgres', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase(TEST_DATABASE_URL ?? '');
    await seedOrganization(db.pool, { holdingId: HOLDING, institutionId: INST });
    // syllabus_items references courses(id): seed the fixture's courses.
    await db.pool.query(
      `INSERT INTO academic_programs (id, institution_id, name, code) VALUES ($1, $2, 'Direito', 'DIR')`,
      [PROGRAM, INST],
    );
    await db.pool.query(
      `INSERT INTO academic_terms (id, institution_id, name, start_date, end_date) VALUES ($1, $2, '2026/2', '2026-11-02', '2026-12-18')`,
      [TERM, INST],
    );
    for (const [id, code] of [
      [C1, 'DIR101'],
      [C2, 'ECO201'],
      [C3, 'MED300'],
    ] as const) {
      await db.pool.query(
        `INSERT INTO courses (id, institution_id, academic_program_id, academic_term_id, code, name, discipline) VALUES ($1, $2, $3, $4, $5, $5, 'x')`,
        [id, INST, PROGRAM, TERM, code],
      );
    }
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  const pgSetup = () =>
    setup({ repository: new PgAnalyticsRepository(db.pool), directory: new PgDirectory(db.pool) });

  it('mirrors sections, enrollments and classrooms through the sync feeds', async () => {
    const { app } = await pgSetup();
    const counts = await db.pool.query<{ s: number; e: number; c: number }>(
      `SELECT (SELECT count(*) FROM analytics_sections)::int AS s, (SELECT count(*) FROM analytics_enrollments)::int AS e,
              (SELECT count(*) FROM analytics_classrooms)::int AS c`,
    );
    expect(counts.rows[0]).toEqual({ s: 3, e: 18, c: 2 });
    // replace semantics
    const r = await app.inject({
      method: 'POST',
      url: '/v1/sync/enrollments',
      headers: internal,
      payload: { classSectionId: S1, studentIds: [PROF_A] },
    });
    expect(r.json()).toMatchObject({ enrolled: 1 });
  });

  it('stores syllabi and computes coverage', async () => {
    const { app } = await pgSetup();
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/courses/${C1}/syllabus`,
      headers: coordinator,
      payload: {
        items: [
          {
            id: 'u1',
            title: 'Controle de constitucionalidade',
            keywords: ['controle difuso'],
            plannedWeek: 1,
          },
          { id: 'u4', title: 'Teoria do Estado', plannedWeek: 1 },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    const got = (
      await app.inject({ url: `/v1/courses/${C1}/syllabus`, headers: coordinator })
    ).json<{
      items: { id: string; keywords: string[]; plannedWeek: number }[];
      updatedBy: string;
    }>();
    expect(got.items).toEqual([
      {
        id: 'u1',
        title: 'Controle de constitucionalidade',
        keywords: ['controle difuso'],
        plannedWeek: 1,
      },
      { id: 'u4', title: 'Teoria do Estado', keywords: [], plannedWeek: 1 },
    ]);
    expect(got.updatedBy).toBe(PROF_A);
    const cov = (
      await app.inject({ url: `/v1/courses/${C1}/coverage`, headers: coordinator })
    ).json<{ counts: Record<string, number> }>();
    expect(cov.counts).toEqual({ covered: 1, partial: 0, notCovered: 1, total: 2 });
    await app.inject({
      method: 'PUT',
      url: `/v1/courses/${C1}/syllabus`,
      headers: coordinator,
      payload: { items: [] },
    });
    expect(
      (await app.inject({ url: `/v1/courses/${C1}/syllabus`, headers: coordinator })).json<{
        items: unknown[];
      }>().items,
    ).toEqual([]);
  });

  it('persists snapshots and serves reports from them (re-runs replace the day)', async () => {
    const { app, fake } = await pgSetup();
    const run = async (): Promise<void> => {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/snapshots/run',
        headers: internal,
        payload: { institutionId: INST, date: '2026-11-02' },
      });
      expect(r.json()).toMatchObject({ classes: 1 });
    };
    await run();
    await run();
    const facts = await db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM analytics_class_facts',
    );
    expect(facts.rows[0]?.n).toBe(1);

    fake.auditEvents = [];
    const before = fake.calls;
    const body = (
      await app.inject({
        url: q('/reports/processing-latency?from=2026-11-02&to=2026-11-02'),
        headers: coordinator,
      })
    ).json<{
      rows: { stage: string; p50Minutes: number | null }[];
      source: Record<string, number>;
    }>();
    expect(body.source).toEqual({ snapshotDays: 1, liveDays: 0 });
    expect(body.rows.find((r) => r.stage === 'class_end_to_transcript')?.p50Minutes).toBe(50);
    expect(fake.calls).toBe(before);
    const adoption = (
      await app.inject({ url: q('/adoption?from=2026-11-02&to=2026-11-02'), headers: coordinator })
    ).json<{
      professors: {
        professorId: string;
        classesCaptured: number;
        medianReviewLatencyMinutes: number;
      }[];
    }>();
    expect(adoption.professors.find((p) => p.professorId === PROF_A)).toMatchObject({
      classesCaptured: 1,
      medianReviewLatencyMinutes: 90,
    });
  });
});
