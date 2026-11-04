import { describe, expect, it } from 'vitest';
import type { AuditEvent } from './clients.js';
import type { learningPatterns } from './learning-patterns.js';

type Patterns = Awaited<ReturnType<typeof learningPatterns>> & { minCohort: number };
import {
  C1,
  C2,
  coordinator,
  INST,
  OTHER_INST,
  S1,
  S2,
  sc,
  setup,
  student,
  token,
} from './test/fixture.js';

let n = 0;
function event(
  action: string,
  s: number,
  section: string,
  at: string,
  metadata: Record<string, unknown> = {},
): AuditEvent {
  return {
    id: `lp-${++n}`,
    tenantId: INST,
    actorId: student(s),
    actorType: 'student',
    action,
    resourceType: 'lecture_summary',
    resourceId: null,
    metadata: { classSectionId: section, ...metadata },
    occurredAt: at,
  };
}

async function patternsSetup() {
  const ctx = await setup();
  const c1102 = sc(S1, '2026-11-02');
  const c1104 = sc(S1, '2026-11-04');
  const c1109 = sc(S1, '2026-11-09');
  const range = (a: number, b: number): number[] =>
    Array.from({ length: b - a + 1 }, (_, i) => a + i);
  ctx.fake.auditEvents = [
    // class of 11-02 (ends 23:40Z): 6 students view it the same night, 5 the next day, 2 a week later
    ...range(1, 6).map((s) =>
      event('lecture.viewed', s, S1, '2026-11-03T01:00:00.000Z', { scheduledClassId: c1102 }),
    ),
    ...range(1, 5).map((s) =>
      event('lecture.viewed', s, S1, '2026-11-04T10:00:00.000Z', { scheduledClassId: c1102 }),
    ),
    ...range(1, 2).map((s) =>
      event('lecture.viewed', s, S1, '2026-11-10T10:00:00.000Z', { scheduledClassId: c1102 }),
    ),
    // baseline week before the revisit window of the 11-20 exam (11-06..11-12): students 1–5
    ...range(1, 5).map((s) =>
      event('lecture.viewed', s, S1, '2026-11-08T12:00:00.000Z', { scheduledClassId: c1104 }),
    ),
    // revisit window (11-13..11-19): students 1–6
    ...range(1, 6).map((s) =>
      event('lecture.viewed', s, S1, '2026-11-18T12:00:00.000Z', { scheduledClassId: c1104 }),
    ),
    // assistant questions: 5 students ask 8 questions about 11-04; 2 students about 11-09 (below cohort)
    ...range(1, 5).map((s) =>
      event('lecture.assistant_question', s, S1, '2026-11-05T12:00:00.000Z', {
        scheduledClassId: c1104,
      }),
    ),
    ...range(1, 3).map((s) =>
      event('lecture.assistant_question', s, S1, '2026-11-06T12:00:00.000Z', {
        scheduledClassId: c1104,
      }),
    ),
    ...range(1, 2).map((s) =>
      event('lecture.assistant_question', s, S1, '2026-11-09T23:59:00.000Z', {
        scheduledClassId: c1109,
      }),
    ),
    event('lecture.assistant_question', 7, S1, '2026-11-07T12:00:00.000Z'),
    // searches: "garantias" fails for 5 students, "xyz" for 2; some searches succeed
    ...range(1, 5).map((s) =>
      event('lecture.searched', s, S1, '2026-11-06T09:00:00.000Z', {
        resultCount: 0,
        zeroResultTerms: ['garant'],
      }),
    ),
    ...range(6, 7).map((s) =>
      event('lecture.searched', s, S1, '2026-11-06T09:00:00.000Z', {
        resultCount: 0,
        zeroResultTerms: ['xyz'],
      }),
    ),
    ...range(1, 3).map((s) =>
      event('lecture.searched', s, S1, '2026-11-07T09:00:00.000Z', { resultCount: 4 }),
    ),
    // S2: two students only
    ...range(4, 5).map((s) =>
      event('lecture.viewed', s, S2, '2026-11-04T10:00:00.000Z', {
        scheduledClassId: sc(S2, '2026-11-03'),
      }),
    ),
    // non-student and unattributed events are ignored
    { ...event('lecture.viewed', 1, S1, '2026-11-04T10:00:00.000Z'), actorType: 'professor' },
  ];
  return ctx;
}

const url = (path: string): string => `${path}?from=2026-11-01&to=2026-11-30`;

describe('learning patterns (6.7)', () => {
  it('builds cohort-safe course patterns', async () => {
    const { app } = await patternsSetup();
    const res = await app.inject({
      url: url(`/v1/courses/${C1}/learning-patterns`),
      headers: coordinator,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Patterns>();
    expect(body.minCohort).toBe(5);
    expect(body.activeStudents).toEqual({ count: 7, suppressed: false });

    const buckets = body.engagementCurve.buckets as {
      daysAfterClass: string;
      views: number | null;
      students: number | null;
      suppressed: boolean;
    }[];
    expect(buckets[0]).toMatchObject({
      daysAfterClass: '0',
      views: 6,
      students: 6,
      suppressed: false,
    });
    expect(buckets[1]).toMatchObject({ daysAfterClass: '1', views: 5, students: 5 });
    expect(buckets[7]).toMatchObject({
      daysAfterClass: '7',
      views: null,
      students: null,
      suppressed: true,
    });
    expect(body.engagementCurve.summary.suppressed).toBe(false);
    expect(typeof body.engagementCurve.summary.medianDaysToFirstView).toBe('number');

    const revisit = body.revisitBeforeAssessments.assessments as {
      assessmentId: string;
      revisitRate: number | null;
      baselineRate: number | null;
      lift: number | null;
      suppressed: boolean;
    }[];
    expect(revisit.find((r) => r.assessmentId === 'ce1')).toMatchObject({
      revisitRate: 0.75,
      baselineRate: 0.625,
      lift: 0.125,
      suppressed: false,
    });

    const topics = body.difficultTopics.topics as {
      scheduledClassId: string;
      questions: number;
      students: number;
      topics: string[];
      questionsPerEnrolledStudent: number;
    }[];
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({
      scheduledClassId: sc(S1, '2026-11-04'),
      questions: 8,
      students: 5,
      topics: ['Direitos fundamentais'],
      questionsPerEnrolledStudent: 1,
    });
    expect(body.difficultTopics.summary).toMatchObject({ questions: 11, unattributedQuestions: 1 });

    expect(body.searchesWithoutResults.terms).toEqual([
      { term: 'garant', searches: 5, students: 5 },
    ]);
    expect(body.searchesWithoutResults.summary).toMatchObject({
      searches: 10,
      zeroResultSearches: 7,
      zeroResultRate: 0.7,
    });

    const days = body.engagementVsAssessments.days as {
      date: string;
      assessments: number;
      views: number | null;
      suppressed: boolean;
    }[];
    expect(days.find((d) => d.date === '2026-11-20')).toMatchObject({ assessments: 1 });
    expect(days.find((d) => d.date === '2026-11-18')).toMatchObject({
      views: 6,
      suppressed: false,
    });
    expect(days.find((d) => d.date === '2026-11-10')).toMatchObject({
      views: null,
      suppressed: true,
    });

    const text = JSON.stringify(body);
    for (let s = 1; s <= 10; s++) expect(text).not.toContain(student(s));
  });

  it('suppresses small courses and summarises the institution per course', async () => {
    const { app } = await patternsSetup();
    const small = (
      await app.inject({ url: url(`/v1/courses/${C2}/learning-patterns`), headers: coordinator })
    ).json<Patterns>();
    expect(small.activeStudents).toEqual({ count: null, suppressed: true });
    expect(small.engagementCurve.summary).toMatchObject({ suppressed: true, views: null });

    const inst = (
      await app.inject({
        url: url(`/v1/institutions/${INST}/learning-patterns`),
        headers: coordinator,
      })
    ).json<{
      courses: {
        courseId: string;
        activeStudents: { count: number | null };
        topDifficultTopic: unknown;
      }[];
      overall: { activeStudents: { count: number } };
    }>();
    expect(inst.overall.activeStudents.count).toBe(7);
    expect(inst.courses.find((c) => c.courseId === C1)).toMatchObject({
      activeStudents: { count: 7 },
      topDifficultTopic: { questions: 8 },
    });
    expect(inst.courses.find((c) => c.courseId === C2)).toMatchObject({
      activeStudents: { count: null },
      topDifficultTopic: null,
    });
  });

  it('requires coordinator/admin of the institution and validates ranges', async () => {
    const { app } = await patternsSetup();
    expect((await app.inject({ url: url(`/v1/courses/${C1}/learning-patterns`) })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          url: url(`/v1/courses/${C1}/learning-patterns`),
          headers: { authorization: `Bearer ${token('student')}` },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: url(`/v1/institutions/${INST}/learning-patterns`),
          headers: { authorization: `Bearer ${token('coordinator', OTHER_INST)}` },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: `/v1/courses/${C1}/learning-patterns?from=2026-01-01&to=2026-12-31`,
          headers: coordinator,
        })
      ).statusCode,
    ).toBe(400);
  });
});
