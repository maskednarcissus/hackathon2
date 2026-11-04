import { describe, expect, it } from 'vitest';
import {
  C1,
  C2,
  coordinator,
  INST,
  internal,
  internalBearer,
  OTHER_INST,
  PROF_A,
  PROF_B,
  R1,
  S1,
  S2,
  S3,
  sc,
  setup,
  student,
  token,
} from './test/fixture.js';

const q = (path: string): string => `/v1/institutions/${INST}${path}`;

describe('auth', () => {
  it('requires a coordinator/admin token of the same institution', async () => {
    const { app } = await setup();
    const url = q('/adoption?from=2026-11-01&to=2026-11-10');
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect(
      (await app.inject({ url, headers: { authorization: 'Bearer nonsense' } })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url, headers: { authorization: `Bearer ${token('student')}` } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url, headers: { authorization: `Bearer ${token('professor')}` } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url,
          headers: { authorization: `Bearer ${token('coordinator', OTHER_INST)}` },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ url, headers: coordinator })).statusCode).toBe(200);
    expect(
      (await app.inject({ url, headers: { authorization: `Bearer ${token('admin')}` } }))
        .statusCode,
    ).toBe(200);
  });

  it('protects data feeds and accepts AUTH_DISABLED for development', async () => {
    const { app } = await setup();
    const payload = { sections: [{ classSectionId: S3, institutionId: INST, courseId: C1 }] };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/sync/sections',
          headers: coordinator,
          payload,
        })
      ).statusCode,
    ).toBe(403);
    const otherAdmin = { authorization: `Bearer ${token('admin', OTHER_INST)}` };
    expect(
      (await app.inject({ method: 'POST', url: '/v1/sync/sections', headers: otherAdmin, payload }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/sync/sections', headers: internal, payload }))
        .statusCode,
    ).toBe(200);
    const bearer = {
      method: 'POST' as const,
      url: '/v1/sync/sections',
      headers: internalBearer,
      payload,
    };
    expect((await app.inject(bearer)).statusCode).toBe(200);
    const wrong = await app.inject({ ...bearer, headers: { 'x-internal-token': 'nope' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json<{ error: { code: string } }>().error.code).toBe('internal_token_required');

    const dev = await setup({ authDisabled: true });
    expect(
      (await dev.app.inject({ url: q('/assessment-calendar?from=2026-11-15&to=2026-11-30') }))
        .statusCode,
    ).toBe(200);
  });
});

describe('4.2 syllabus coverage', () => {
  it('matches syllabus items to lecture topics and flags items behind schedule', async () => {
    const { app } = await setup();
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/courses/${C1}/syllabus`,
      headers: coordinator,
      payload: {
        items: [
          { id: 'u1', title: 'Controle de constitucionalidade', plannedWeek: 1 },
          {
            id: 'u2',
            title: 'Direitos fundamentais',
            keywords: ['garantias individuais'],
            plannedWeek: 1,
          },
          { id: 'u3', title: 'Controle difuso de constitucionalidade', plannedWeek: 3 },
          { id: 'u4', title: 'Teoria do Estado', plannedWeek: 1 },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ institutionId: INST, updatedBy: PROF_A });
    const res = await app.inject({ url: `/v1/courses/${C1}/coverage`, headers: coordinator });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      items: {
        id: string;
        status: string;
        coverageScore: number;
        behindSchedule: boolean;
        firstCoveredWeek: number | null;
        matchedLectures: { scheduledClassId: string; topicTitle: string }[];
      }[];
      counts: Record<string, number>;
      coverageRatio: number;
      currentWeek: number;
      lecturesAnalysed: number;
    }>();
    const byId = Object.fromEntries(body.items.map((i) => [i.id, i]));
    expect(body.lecturesAnalysed).toBe(2);
    expect(body.currentWeek).toBe(2);
    expect(byId['u1']).toMatchObject({
      status: 'covered',
      firstCoveredWeek: 1,
      behindSchedule: false,
    });
    expect(byId['u1']?.matchedLectures[0]).toMatchObject({
      scheduledClassId: sc(S1, '2026-11-02'),
      topicTitle: 'Controle de constitucionalidade',
    });
    expect(byId['u2']).toMatchObject({ status: 'covered' });
    expect(byId['u3']?.status).toBe('partial');
    expect(byId['u3']?.behindSchedule).toBe(false); // planned for week 3, we are in week 2
    expect(byId['u4']).toMatchObject({
      status: 'not_covered',
      behindSchedule: true,
      matchedLectures: [],
    });
    expect(body.counts).toEqual({ covered: 2, partial: 1, notCovered: 1, total: 4 });
    expect(body.coverageRatio).toBe(0.5);
  });

  it('validates syllabi and scopes them to the course institution', async () => {
    const { app } = await setup();
    const dup = await app.inject({
      method: 'PUT',
      url: `/v1/courses/${C1}/syllabus`,
      headers: coordinator,
      payload: {
        items: [
          { id: 'a', title: 'x' },
          { id: 'a', title: 'y' },
        ],
      },
    });
    expect(dup.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'PUT',
      url: `/v1/courses/${PROF_A}/syllabus`,
      headers: coordinator,
      payload: { items: [] },
    });
    expect(unknown.statusCode).toBe(404);
    const other = await app.inject({
      url: `/v1/courses/${C1}/coverage`,
      headers: { authorization: `Bearer ${token('coordinator', OTHER_INST)}` },
    });
    expect(other.statusCode).toBe(403);
    expect(
      (await app.inject({ url: `/v1/courses/${C1}/coverage`, headers: coordinator })).statusCode,
    ).toBe(404);
  });
});

describe('4.3 assessment calendar', () => {
  it('lists published and pending assessments per day with cohort-safe counts', async () => {
    const { app } = await setup();
    const res = await app.inject({
      url: q('/assessment-calendar?from=2026-11-15&to=2026-11-30'),
      headers: coordinator,
    });
    const body = res.json<{
      days: {
        date: string;
        load: number;
        awaitingReview: number;
        items: {
          id: string;
          status: string;
          enrolledStudents: { count: number | null; suppressed: boolean };
        }[];
      }[];
      totals: Record<string, number>;
    }>();
    expect(body.days.map((d) => [d.date, d.load])).toEqual([
      ['2026-11-18', 1],
      ['2026-11-19', 1],
      ['2026-11-20', 2],
    ]);
    expect(body.days[0]?.items[0]).toMatchObject({
      id: 'e2',
      status: 'awaiting_review',
      enrolledStudents: { count: 8, suppressed: false },
    });
    expect(body.days[1]?.items[0]).toMatchObject({
      id: 'ce3',
      enrolledStudents: { count: null, suppressed: true },
    });
    expect(body.totals).toMatchObject({
      assessments: 4,
      published: 3,
      awaitingReview: 1,
      maxDailyLoad: 2,
    });

    const published = (
      await app.inject({
        url: q('/assessment-calendar?from=2026-11-15&to=2026-11-30&includePending=false'),
        headers: coordinator,
      })
    ).json<{ totals: { assessments: number } }>();
    expect(published.totals.assessments).toBe(3);
    const course = (
      await app.inject({
        url: q(`/assessment-calendar?from=2026-11-15&to=2026-11-30&courseId=${C2}`),
        headers: coordinator,
      })
    ).json<{ totals: { assessments: number } }>();
    expect(course.totals.assessments).toBe(1);
    expect(
      (
        await app.inject({
          url: q('/assessment-calendar?from=2026-11-30&to=2026-11-15'),
          headers: coordinator,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: q('/assessment-calendar?from=2026-01-01&to=2026-12-31'),
          headers: coordinator,
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('4.4 cross-course conflicts', () => {
  it('detects shared-student overlaps, load and same-program days without exposing students', async () => {
    const { app } = await setup();
    const res = await app.inject({
      url: q('/assessment-conflicts?from=2026-11-15&to=2026-11-30'),
      headers: coordinator,
    });
    const body = res.json<{
      conflicts: {
        kind: string;
        severity: string;
        date: string;
        students: { count: number | null; suppressed: boolean };
        affectedSections: string[];
        includesPendingReview: boolean;
      }[];
      counts: Record<string, number>;
    }>();
    const kinds = body.conflicts.map(
      (c) => `${c.date}:${c.kind}:${c.severity}:${String(c.students.count)}`,
    );
    expect(kinds).toEqual([
      '2026-11-18:assessment_load:warning:8',
      '2026-11-20:assessment_overlap_shared_students:warning:5',
      '2026-11-20:same_day_same_program:info:10',
    ]);
    expect(body.conflicts[0]?.affectedSections.sort()).toEqual([S1, S2, S3].sort());
    expect(body.conflicts[0]?.includesPendingReview).toBe(true);
    expect(JSON.stringify(body)).not.toContain(student(1));
  });

  it('suppresses counts below the minimum cohort and marks exam clashes as blocking', async () => {
    const { app, fake } = await setup();
    await app.inject({
      method: 'POST',
      url: '/v1/sync/enrollments',
      headers: internal,
      payload: { classSectionId: S2, studentIds: [student(7), student(8), student(9)] },
    });
    fake.calendarEvents = fake.calendarEvents.map((e) =>
      e.id === 'ce2' ? { ...e, type: 'examination' } : e,
    );
    const body = (
      await app.inject({
        url: q('/assessment-conflicts?from=2026-11-20&to=2026-11-20'),
        headers: coordinator,
      })
    ).json<{
      conflicts: {
        kind: string;
        severity: string;
        students: { count: number | null; suppressed: boolean };
      }[];
    }>();
    expect(
      body.conflicts.find((c) => c.kind === 'assessment_overlap_shared_students'),
    ).toMatchObject({ severity: 'blocking', students: { count: null, suppressed: true } });
  });
});

describe('4.5 adoption', () => {
  it('aggregates per professor and section with cohort-suppressed engagement', async () => {
    const { app } = await setup();
    const res = await app.inject({
      url: q('/adoption?from=2026-11-01&to=2026-11-15'),
      headers: coordinator,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      professors: Record<string, unknown>[];
      sections: Record<string, unknown>[];
      totals: Record<string, unknown>;
      source: { liveDays: number };
    }>();
    const ana = body.professors.find((p) => p['professorId'] === PROF_A);
    expect(ana).toMatchObject({
      professorName: 'Ana Souza',
      classesScheduled: 3,
      classesCancelled: 1,
      classesCaptured: 2,
      classesTranscribed: 2,
      classesStructured: 2,
      captureRate: 0.667,
      eventsExtracted: 3,
      eventsReviewed: 2,
      reviewRate: 0.667,
      medianReviewLatencyMinutes: 90,
      correctionsMade: 3,
    });
    const s1 = body.sections.find((s) => s['classSectionId'] === S1);
    expect(s1?.['engagement']).toEqual({
      suppressed: false,
      cohortSize: 6,
      views: 6,
      searches: 1,
      assistantQuestions: 0,
      activeStudents: 6,
    });
    const s2 = body.sections.find((s) => s['classSectionId'] === S2);
    expect(s2?.['engagement']).toEqual({
      suppressed: true,
      cohortSize: null,
      views: null,
      searches: null,
      assistantQuestions: null,
      activeStudents: null,
    });
    expect(s2).toMatchObject({ classesScheduled: 2, classesCaptured: 1, classesTranscribed: 0 });
    expect(body.professors.find((p) => p['professorId'] === PROF_B)?.['sections']).toEqual(
      expect.arrayContaining([S2, S3]),
    );
    expect(body.source.liveDays).toBe(15);
  });
});

describe('4.9 operational reports', () => {
  it('produces capture coverage as JSON and RFC 4180 CSV', async () => {
    const { app } = await setup();
    const json = (
      await app.inject({
        url: q('/reports/capture-coverage?from=2026-11-01&to=2026-11-10'),
        headers: coordinator,
      })
    ).json<{ rows: Record<string, unknown>[]; summary: Record<string, unknown> }>();
    expect(json.summary).toMatchObject({ scheduled: 6, captured: 3, coverage: 0.5, cancelled: 1 });
    expect(json.rows[0]).toMatchObject({
      date: '2026-11-02',
      classroomId: R1,
      classroomName: 'Sala 101, Bloco A',
      scheduled: 1,
      captured: 1,
      coverage: 1,
    });
    const csv = await app.inject({
      url: q('/reports/capture-coverage?from=2026-11-01&to=2026-11-10&format=csv'),
      headers: coordinator,
    });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain(
      'capture-coverage_2026-11-01_2026-11-10.csv',
    );
    const lines = csv.body.split('\r\n');
    expect(lines[0]).toBe(
      'date,campusId,campusName,classroomId,classroomName,scheduled,captured,missed,coverage',
    );
    expect(lines[1]).toContain(',"Sala 101, Bloco A",1,1,0,1');
    expect(csv.body.endsWith('\r\n')).toBe(true);
  });

  it('reports transcription success, corrections and processing latency', async () => {
    const { app } = await setup();
    const get = async (kind: string) =>
      (
        await app.inject({
          url: q(`/reports/${kind}?from=2026-11-01&to=2026-11-10`),
          headers: coordinator,
        })
      ).json<{ rows: Record<string, unknown>[]; summary: Record<string, unknown> }>();
    const ts = await get('transcription-success');
    expect(ts.summary).toMatchObject({
      captured: 3,
      transcribed: 2,
      failed: 1,
      successRate: 0.667,
      meanConfidence: 0.85,
      failuresByReason: { provider_error: 1 },
    });
    expect(ts.rows.find((r) => r['courseId'] === C2)).toMatchObject({
      captured: 1,
      failed: 1,
      successRate: 0,
    });
    const corr = await get('corrections');
    expect(corr.rows.find((r) => r['courseId'] === C1)).toMatchObject({
      transcriptSegmentsCorrected: 2,
      eventsExtracted: 3,
      eventEdits: 1,
      eventRejections: 1,
    });
    const lat = await get('processing-latency');
    expect(lat.rows.find((r) => r['stage'] === 'class_end_to_transcript')).toMatchObject({
      samples: 2,
      p50Minutes: 50,
      p95Minutes: 120,
    });
    expect(lat.rows.find((r) => r['stage'] === 'transcript_to_summary')).toMatchObject({
      samples: 2,
      p50Minutes: 30,
      p95Minutes: 60,
    });
    expect(
      (await app.inject({ url: q('/reports/unknown'), headers: coordinator })).statusCode,
    ).toBe(400);
  });

  it('returns 502 when an upstream is down', async () => {
    const broken = await setup();
    const { UpstreamError } = await import('./clients.js');
    // Any read of the audit data now fails the way an HTTP client would.
    broken.fake.auditEvents = new Proxy([], {
      get() {
        throw new UpstreamError('audit', 'HTTP 503');
      },
    });
    const r = await broken.app.inject({
      url: q('/reports/capture-coverage?from=2026-11-01&to=2026-11-02'),
      headers: coordinator,
    });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({
      error: { code: 'upstream_unavailable', details: { service: 'audit' } },
    });
  });
});

describe('snapshots', () => {
  it('materialises closed days and serves them instead of live collection', async () => {
    const { app, fake } = await setup();
    const run = await app.inject({
      method: 'POST',
      url: '/v1/snapshots/run',
      headers: internal,
      payload: { institutionId: INST, date: '2026-11-02' },
    });
    expect(run.json()).toMatchObject({ date: '2026-11-02', classes: 1 });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/snapshots/run',
          headers: internal,
          payload: { institutionId: INST, date: '2026-11-10' },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/snapshots/run',
          headers: coordinator,
          payload: { institutionId: INST },
        })
      ).statusCode,
    ).toBe(403);

    fake.auditEvents = []; // upstream history gone: the snapshot still answers
    const before = fake.calls;
    const body = (
      await app.inject({
        url: q('/reports/capture-coverage?from=2026-11-02&to=2026-11-02'),
        headers: coordinator,
      })
    ).json<{ summary: Record<string, unknown>; source: Record<string, number> }>();
    expect(body.source).toEqual({ snapshotDays: 1, liveDays: 0 });
    expect(body.summary).toMatchObject({ scheduled: 1, captured: 1 });
    expect(fake.calls).toBe(before);
    const list = (
      await app.inject({
        url: `/v1/snapshots?institutionId=${INST}&from=2026-11-01&to=2026-11-10`,
        headers: coordinator,
      })
    ).json<{ items: unknown[] }>();
    expect(list.items).toEqual([
      { date: '2026-11-02', generatedAt: '2026-11-10T12:00:00.000Z', classes: 1 },
    ]);
  });
});

describe('overview', () => {
  it('composes today capture, fleet summary and open alerts', async () => {
    const { app, fake } = await setup();
    fake.fleet = {
      generatedAt: 'x',
      summary: { total: 2, byStatus: { online: 1, offline: 1 }, withIssues: 1 },
      devices: [],
    };
    fake.alerts = [
      {
        id: 'a1',
        rule: 'device_offline',
        institutionId: INST,
        classroomId: R1,
        scheduledClassId: null,
        severity: 'high',
        status: 'open',
        firstRaisedAt: 'x',
      },
      {
        id: 'a2',
        rule: 'failed_upload',
        institutionId: INST,
        classroomId: R1,
        scheduledClassId: null,
        severity: 'medium',
        status: 'resolved',
        firstRaisedAt: 'x',
      },
    ];
    const body = (
      await app.inject({ url: q('/overview?date=2026-11-09'), headers: coordinator })
    ).json<Record<string, unknown>>();
    expect(body).toMatchObject({
      capture: { due: 1, captured: 0 },
      fleet: { total: 2 },
      openAlerts: { total: 1, bySeverity: { high: 1 } },
      errors: {},
    });
  });
});
