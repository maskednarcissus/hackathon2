import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import {
  InMemoryAuditClient,
  OrganizationUnavailableError,
  StaticOrganizationClient,
  type OrganizationClient,
} from './clients.js';
import type { ImportReport, ScheduledClass } from './domain.js';
import { InMemoryAcademicRepository } from './repository.js';

const INST = '11111111-1111-4111-8111-111111111111';
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
      { studentExternalId: 'S2', classSectionExternalId: 'DIR101-A' },
    ],
    ...overrides,
  };
}

function setup(org?: OrganizationClient) {
  const repo = new InMemoryAcademicRepository();
  const audit = new InMemoryAuditClient();
  const organization =
    org ??
    new StaticOrganizationClient(
      new Map([
        [ROOM, { id: POLICY, preRollMinutes: 5, postRollMinutes: 10, recordingEnabled: true }],
      ]),
    );
  const app = buildApp({
    repository: repo,
    organization,
    audit,
    clock: { now: () => new Date('2026-11-04T12:00:00Z') },
  });
  return { app, repo, audit };
}

async function listRoom(
  app: ReturnType<typeof buildApp>,
  room: string,
  from: string,
  to: string,
  cancelled = false,
) {
  const r = await app.inject({
    url: `/v1/scheduled-classes?classroomId=${room}&from=${from}&to=${to}&includeCancelled=${cancelled}`,
  });
  return r.json<{ items: ScheduledClass[] }>().items;
}

describe('schedule import (1.14)', () => {
  it('imports a timetable and expands it into scheduled classes in campus time', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/imports', payload: payload() });
    expect(res.statusCode).toBe(201);
    const report = res.json<ImportReport>();
    expect(report.status).toBe('applied');
    expect(report.counts.courses.created).toBe(1);
    expect(report.counts.enrollments.created).toBe(2);
    // 2026-08-03..2026-12-11: 19 Mondays + 19 Wednesdays (Nov-04 rescheduled), + 1 extra
    expect(report.counts.scheduledClasses.created).toBe(39);

    const week = await listRoom(app, ROOM, '2026-10-26T00:00:00Z', '2026-11-09T00:00:00Z', true);
    const summary = week.map((c) => [c.localDate, c.startsAt, c.status]);
    expect(summary).toEqual([
      ['2026-10-26', '2026-10-26T22:00:00.000Z', 'scheduled'],
      ['2026-10-28', '2026-10-28T22:00:00.000Z', 'scheduled'],
      ['2026-11-02', '2026-11-02T22:00:00.000Z', 'cancelled'],
      ['2026-11-07', '2026-11-07T12:00:00.000Z', 'scheduled'],
    ]);
    const moved = await listRoom(app, ROOM2, '2026-11-04T00:00:00Z', '2026-11-05T00:00:00Z');
    expect(moved.map((c) => [c.startsAt, c.endsAt, c.source])).toEqual([
      ['2026-11-04T11:00:00.000Z', '2026-11-04T12:40:00.000Z', 'exception'],
    ]);

    const detail = await app.inject({ url: `/v1/scheduled-classes/${moved[0]?.id ?? ''}` });
    expect(detail.json()).toMatchObject({
      course: { code: 'DIR101', name: 'Direito Constitucional I' },
      professor: { name: 'Ana Souza' },
      classSection: { sectionCode: 'A' },
      term: { externalId: '2026-2' },
    });
  });

  it('is idempotent and keeps scheduled class ids stable across re-imports', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/v1/imports', payload: payload() });
    const before = await listRoom(app, ROOM, '2026-08-01T00:00:00Z', '2026-12-31T00:00:00Z');
    const again = (
      await app.inject({ method: 'POST', url: '/v1/imports', payload: payload() })
    ).json<ImportReport>();
    expect(again.counts.scheduledClasses).toEqual({ created: 0, updated: 0, unchanged: 39 });
    expect(again.counts.students).toEqual({ created: 0, updated: 0, unchanged: 2 });

    // Move Wednesday class to 18:30 and drop Monday: Wednesday ids stay, Mondays get cancelled.
    const changed = payload();
    const sections = changed['classSections'] as { schedule: unknown[] }[];
    const section = sections[0];
    if (!section) throw new Error('fixture');
    section.schedule = [{ dayOfWeek: 1, startTime: '18:30', endTime: '20:40', classroomId: ROOM }];
    const r = (
      await app.inject({ method: 'POST', url: '/v1/imports', payload: changed })
    ).json<ImportReport>();
    expect(r.counts.scheduledClasses.updated).toBeGreaterThan(0);
    expect(r.counts.scheduledClassesCancelled).toBe(18); // Wednesdays (Nov-04 slot is the rescheduled one and stays)
    const after = await listRoom(app, ROOM, '2026-08-01T00:00:00Z', '2026-12-31T00:00:00Z');
    const firstMonday = before.find((c) => c.localDate === '2026-08-03');
    expect(after.find((c) => c.localDate === '2026-08-03')).toMatchObject({
      id: firstMonday?.id,
      startsAt: '2026-08-03T21:30:00.000Z',
    });
    expect(after.some((c) => c.localDate === '2026-08-05')).toBe(false);
  });

  it('supports dry runs without persisting', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      payload: payload({ dryRun: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<ImportReport>()).toMatchObject({ status: 'validated', dryRun: true });
    expect(await listRoom(app, ROOM, '2026-08-01T00:00:00Z', '2026-12-31T00:00:00Z')).toHaveLength(
      0,
    );
    const stored = await app.inject({ url: `/v1/imports/${res.json<ImportReport>().importId}` });
    expect(stored.statusCode).toBe(200);
  });

  it('rejects the whole import with per-row error paths', async () => {
    const { app } = setup();
    const bad = payload({
      enrollments: [{ studentExternalId: 'S9', classSectionExternalId: 'DIR101-A' }],
      professors: [{ externalId: 'P1', name: 'Ana', email: 'not-an-email' }],
    });
    const r1 = await app.inject({ method: 'POST', url: '/v1/imports', payload: bad });
    expect(r1.statusCode).toBe(422);
    expect(r1.json<ImportReport>().errors.map((e) => e.path)).toContain('professors[0].email');

    const refs = payload({
      enrollments: [{ studentExternalId: 'S9', classSectionExternalId: 'DIR101-A' }],
    });
    const sections = refs['classSections'] as Record<string, unknown>[];
    sections.push({
      ...sections[0],
      externalId: 'DIR101-B',
      courseExternalId: 'NOPE',
      schedule: [
        { dayOfWeek: 2, startTime: '10:00', endTime: '12:00', classroomId: ROOM },
        { dayOfWeek: 2, startTime: '11:00', endTime: '13:00', classroomId: ROOM },
      ],
    });
    const r2 = (
      await app.inject({ method: 'POST', url: '/v1/imports', payload: refs })
    ).json<ImportReport>();
    expect(r2.status).toBe('rejected');
    expect(r2.errors.map((e) => `${e.path}:${e.code}`)).toEqual(
      expect.arrayContaining([
        'classSections[1].courseExternalId:unknown_reference',
        'classSections[1].schedule[1]:overlapping_slot',
        'enrollments[0].studentExternalId:unknown_reference',
      ]),
    );
    expect(await listRoom(app, ROOM, '2026-08-01T00:00:00Z', '2026-12-31T00:00:00Z')).toHaveLength(
      0,
    );

    const outside = payload({
      classSections: [
        { ...(payload()['classSections'] as object[])[0], cancelledDates: ['2027-01-10'] },
      ],
    });
    const r3 = (
      await app.inject({ method: 'POST', url: '/v1/imports', payload: outside })
    ).json<ImportReport>();
    expect(r3.errors[0]).toMatchObject({ code: 'outside_term' });
  });

  it('imports a timetable CSV', async () => {
    const { app } = setup();
    const csv = [
      'term_external_id;term_name;term_start;term_end;course_external_id;course_code;course_name;discipline;professor_external_id;professor_name;professor_email;section_external_id;section_code;day_of_week;start_time;end_time;classroom_id',
      `2026-2;2026/2;2026-08-03;2026-12-11;MED200;MED200;"Anatomia; Sistêmica";medicine;P2;Rui Alves;rui@uni.example;MED200-A;A;terça;08:00;09:40;${ROOM}`,
      `2026-2;2026/2;2026-08-03;2026-12-11;MED200;MED200;"Anatomia; Sistêmica";medicine;P2;Rui Alves;rui@uni.example;MED200-A;A;qui;08:00;09:40;${ROOM}`,
    ].join('\n');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/imports/timetable.csv?institutionId=${INST}`,
      headers: { 'content-type': 'text/csv' },
      payload: csv,
    });
    expect(res.statusCode).toBe(201);
    const r = res.json<ImportReport>();
    expect(r.format).toBe('csv');
    expect(r.counts.scheduledClasses.created).toBe(38);

    const bad = csv.replace(';qui;', ';funday;').replace(';08:00;09:40;', ';8h;09:40;');
    const badRes = await app.inject({
      method: 'POST',
      url: `/v1/imports/timetable.csv?institutionId=${INST}`,
      headers: { 'content-type': 'text/csv' },
      payload: bad,
    });
    expect(badRes.statusCode).toBe(422);
    expect(badRes.json<ImportReport>().errors.map((e) => e.path)).toEqual([
      'row 2.start_time',
      'row 3.day_of_week',
    ]);
  });
});

describe('class identification (1.13)', () => {
  it('identifies the class of a recording and audits the decision', async () => {
    const { app, audit } = setup();
    await app.inject({ method: 'POST', url: '/v1/imports', payload: payload() });
    const rec = '99999999-9999-4999-8999-999999999999';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/class-identification',
      payload: {
        classroomId: ROOM,
        startedAt: '2026-10-26T18:55:00-03:00',
        endedAt: '2026-10-26T20:50:00-03:00',
        recordingSessionId: rec,
      },
    });
    const body = res.json<{
      status: string;
      confidence: number;
      scheduledClass: { localDate: string; course: { code: string } };
    }>();
    expect(body.status).toBe('matched');
    expect(body.confidence).toBeGreaterThan(0.8);
    expect(body.scheduledClass).toMatchObject({
      localDate: '2026-10-26',
      course: { code: 'DIR101' },
    });
    expect(audit.events[0]).toMatchObject({
      action: 'recording.class_identified',
      resourceId: rec,
      tenantId: INST,
      metadata: { status: 'matched' },
    });

    const cancelled = await app.inject({
      method: 'POST',
      url: '/v1/class-identification',
      payload: {
        classroomId: ROOM,
        startedAt: '2026-11-02T19:00:00-03:00',
        endedAt: '2026-11-02T20:40:00-03:00',
      },
    });
    expect(cancelled.json<{ status: string; scheduledClass: unknown }>()).toMatchObject({
      status: 'unmatched',
      scheduledClass: null,
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/class-identification',
      payload: {
        classroomId: ROOM,
        startedAt: '2026-11-02T20:00:00Z',
        endedAt: '2026-11-02T19:00:00Z',
      },
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe('recording plan (contract §4)', () => {
  it('applies pre/post roll and excludes cancelled classes', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/v1/imports', payload: payload() });
    const res = await app.inject({
      url: `/v1/classrooms/${ROOM}/recording-plan?from=2026-11-02T00:00:00Z&to=2026-11-09T00:00:00Z`,
    });
    expect(res.statusCode).toBe(200);
    const plan = res.json<{ timezone: string; windows: Record<string, unknown>[] }>();
    expect(plan.timezone).toBe('America/Sao_Paulo');
    expect(plan.windows).toHaveLength(1); // Mon cancelled, Wed moved to ROOM2, Sat extra
    expect(plan.windows[0]).toMatchObject({
      startsAt: '2026-11-07T12:00:00.000Z',
      recordStartAt: '2026-11-07T11:55:00.000Z',
      recordStopAt: '2026-11-07T15:10:00.000Z',
      recordingPolicyId: POLICY,
      recordingEnabled: true,
    });
  });

  it('marks windows disabled when no policy exists and fails clearly when organization is down', async () => {
    const { app } = setup(new StaticOrganizationClient());
    await app.inject({ method: 'POST', url: '/v1/imports', payload: payload() });
    const plan = (
      await app.inject({
        url: `/v1/classrooms/${ROOM}/recording-plan?from=2026-11-07T00:00:00Z&to=2026-11-08T00:00:00Z`,
      })
    ).json<{ windows: Record<string, unknown>[] }>();
    expect(plan.windows[0]).toMatchObject({
      recordingEnabled: false,
      recordingPolicyId: null,
      disabledReason: 'no_recording_policy',
    });

    const down = setup({
      getClassroomRecordingPolicy: () => Promise.reject(new OrganizationUnavailableError('down')),
    });
    const r = await down.app.inject({ url: `/v1/classrooms/${ROOM}/recording-plan` });
    expect(r.statusCode).toBe(502);
    const tooLong = await app.inject({
      url: `/v1/classrooms/${ROOM}/recording-plan?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z`,
    });
    expect(tooLong.statusCode).toBe(400);
  });
});
