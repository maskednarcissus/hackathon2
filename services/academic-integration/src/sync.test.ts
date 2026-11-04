import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import {
  InMemoryAuditClient,
  StaticClassroomDirectory,
  StaticDeviceDirectory,
  StaticOrganizationClient,
} from './clients.js';
import { InMemoryAcademicRepository } from './repository.js';
import { parseSyncTargets, SyncService } from './sync.js';

const INST = '11111111-1111-4111-8111-111111111111';
const CAMPUS = '12000000-0000-4000-8000-000000000000';
const ROOM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOM2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const POLICY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TOKEN = 'internal-secret';

const importPayload = {
  institutionId: INST,
  term: { externalId: '2026-2', name: '2026/2', startDate: '2026-11-02', endDate: '2026-11-15' },
  courses: [
    { externalId: 'DIR101', code: 'DIR101', name: 'Direito Constitucional I', discipline: 'law' },
  ],
  professors: [{ externalId: 'P1', name: 'Ana Souza', email: 'ana@uni.example' }],
  students: [
    { externalId: 'S1', name: 'Bruno', email: 'bruno@uni.example' },
    { externalId: 'S2', name: 'Carla', email: 'carla@uni.example' },
  ],
  classSections: [
    {
      externalId: 'DIR101-A',
      courseExternalId: 'DIR101',
      professorExternalId: 'P1',
      sectionCode: 'A',
      schedule: [{ dayOfWeek: 3, startTime: '19:00', endTime: '20:40', classroomId: ROOM }],
    },
  ],
  enrollments: [
    { studentExternalId: 'S1', classSectionExternalId: 'DIR101-A' },
    { studentExternalId: 'S2', classSectionExternalId: 'DIR101-A', status: 'withdrawn' },
  ],
};

interface Call {
  url: string;
  token: string | null;
  body: Record<string, unknown>;
}

function fakeFetch(failures: Map<string, number> = new Map()) {
  const calls: Call[] = [];
  const fn = ((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      token: headers['x-internal-token'] ?? null,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    const host = new URL(url).host;
    const left = failures.get(host) ?? 0;
    if (left > 0) {
      failures.set(host, left - 1);
      return Promise.resolve(new Response('{}', { status: 503 }));
    }
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  }) as typeof fetch;
  return { fn, calls };
}

function setup(failures?: Map<string, number>) {
  const repo = new InMemoryAcademicRepository();
  const { fn, calls } = fakeFetch(failures);
  const targets = parseSyncTargets(
    'identity=http://identity:4001,calendar=http://calendar:4005,notifications=http://notifications:4006,analytics=http://academic-analytics:4009',
  );
  const classrooms = new StaticClassroomDirectory([
    {
      classroomId: ROOM,
      institutionId: INST,
      campusId: CAMPUS,
      campusName: 'Centro',
      name: 'Sala 101',
    },
  ]);
  const sync = new SyncService(targets, repo, classrooms, {
    internalToken: TOKEN,
    fetch: fn,
    backoffMs: 1,
    retryIntervalMs: 0,
  });
  const organization = new StaticOrganizationClient(
    new Map([
      [ROOM, { id: POLICY, preRollMinutes: 5, postRollMinutes: 10, recordingEnabled: true }],
    ]),
  );
  const devices = new StaticDeviceDirectory([
    {
      id: DEVICE,
      institutionId: INST,
      classroomId: ROOM,
      lastSeenAt: '2026-11-04T21:59:00.000Z',
      status: 'online',
      credentialStatus: 'active',
    },
    {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      institutionId: INST,
      classroomId: ROOM2,
      lastSeenAt: null,
      status: 'offline',
      credentialStatus: 'revoked',
    },
  ]);
  const app = buildApp({
    repository: repo,
    organization,
    audit: new InMemoryAuditClient(),
    sync,
    devices,
    internalToken: TOKEN,
    clock: { now: () => new Date('2026-11-04T22:30:00.000Z') },
  });
  return { app, sync, calls };
}

const byPath = (calls: Call[], prefix: string): Call[] =>
  calls.filter((c) => c.url.startsWith(prefix));

describe('SYNC_TARGETS parsing', () => {
  it('infers target kinds from names and rejects malformed entries', () => {
    expect(
      parseSyncTargets(' identity=http://id:4001/ , academic-analytics=https://a.example'),
    ).toEqual([
      { name: 'identity', kind: 'identity', url: 'http://id:4001' },
      { name: 'academic-analytics', kind: 'analytics', url: 'https://a.example' },
    ]);
    expect(parseSyncTargets(undefined)).toEqual([]);
    expect(() => parseSyncTargets('billing=http://x')).toThrow();
    expect(() => parseSyncTargets('identity=ftp://x')).toThrow();
  });
});

describe('sync push after import (integration-stage §3)', () => {
  it('maps the canonical data to every target body with the internal token', async () => {
    const { app, sync, calls } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/imports', payload: importPayload });
    expect(res.statusCode).toBe(201);
    await sync.idle();
    expect(calls.every((c) => c.token === TOKEN)).toBe(true);
    const section = (
      await app.inject({
        url: `/v1/scheduled-classes?classroomId=${ROOM}&from=2026-11-01T00:00:00Z&to=2026-11-30T00:00:00Z`,
      })
    ).json<{ items: { classSectionId: string; courseId: string; professorId: string }[] }>()
      .items[0];
    if (!section) throw new Error('no class');

    const [idSections, idEnrollments] = byPath(calls, 'http://identity:4001');
    expect(idSections?.url).toBe('http://identity:4001/v1/sync/sections');
    expect(idSections?.body).toEqual({
      institutionId: INST,
      sections: [
        {
          classSectionId: section.classSectionId,
          professorId: section.professorId,
          courseId: section.courseId,
        },
      ],
    });
    expect(idEnrollments?.url).toBe('http://identity:4001/v1/sync/enrollments');
    expect(idEnrollments?.body).toMatchObject({ institutionId: INST, mode: 'replace' });
    expect(
      (idEnrollments?.body['enrollments'] as { status: string }[]).map((e) => e.status).sort(),
    ).toEqual(['active', 'withdrawn']);
    expect(JSON.stringify(idEnrollments?.body)).not.toContain('email');

    const [calSections, calEnrollments] = byPath(calls, 'http://calendar:4005');
    expect(calSections?.url).toBe('http://calendar:4005/v1/sections');
    expect(calSections?.body).toEqual({
      sections: [
        {
          classSectionId: section.classSectionId,
          institutionId: INST,
          courseId: section.courseId,
          professorId: section.professorId,
          courseName: 'Direito Constitucional I',
          sectionCode: 'A',
        },
      ],
    });
    expect(calEnrollments?.url).toBe('http://calendar:4005/v1/enrollments/bulk');
    expect(calEnrollments?.body).toMatchObject({
      classSectionId: section.classSectionId,
      mode: 'replace',
    });
    expect(calEnrollments?.body['studentIds']).toHaveLength(1); // active only

    const [notif] = byPath(calls, 'http://notifications:4006');
    expect(notif?.url).toBe('http://notifications:4006/v1/sync/enrollments');
    expect((notif?.body['enrollments'] as { email?: string }[]).map((e) => e.email).sort()).toEqual(
      ['bruno@uni.example', 'carla@uni.example'],
    );

    const analytics = byPath(calls, 'http://academic-analytics:4009');
    expect(analytics.map((c) => new URL(c.url).pathname)).toEqual([
      '/v1/sync/sections',
      '/v1/sync/enrollments',
      '/v1/sync/classrooms',
    ]);
    expect(analytics[0]?.body).toEqual({
      sections: [
        {
          classSectionId: section.classSectionId,
          institutionId: INST,
          courseId: section.courseId,
          courseCode: 'DIR101',
          courseName: 'Direito Constitucional I',
          professorId: section.professorId,
          professorName: 'Ana Souza',
          sectionCode: 'A',
          termStartDate: '2026-11-02',
          termEndDate: '2026-11-15',
        },
      ],
    });
    expect(analytics[2]?.body).toEqual({
      classrooms: [
        {
          classroomId: ROOM,
          institutionId: INST,
          campusId: CAMPUS,
          campusName: 'Centro',
          name: 'Sala 101',
        },
      ],
    });

    const status = (
      await app.inject({ url: '/v1/sync/status', headers: { 'x-internal-token': TOKEN } })
    ).json<{
      targets: {
        name: string;
        state: string;
        lastPush: { sections: number; enrollments: number };
      }[];
    }>();
    expect(status.targets.map((t) => [t.name, t.state])).toEqual([
      ['identity', 'ok'],
      ['calendar', 'ok'],
      ['notifications', 'ok'],
      ['analytics', 'ok'],
    ]);
    expect(status.targets[0]?.lastPush).toMatchObject({ sections: 1, enrollments: 2 });
  });

  it('does not push on dry runs or rejected imports', async () => {
    const { app, sync, calls } = setup();
    await app.inject({
      method: 'POST',
      url: '/v1/imports',
      payload: { ...importPayload, dryRun: true },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/imports',
      payload: { ...importPayload, professors: [] },
    });
    await sync.idle();
    expect(calls).toHaveLength(0);
  });

  it('retries transient failures and reports persistent ones in /v1/sync/status', async () => {
    const failures = new Map([
      ['identity:4001', 1], // recovers on retry
      ['calendar:4005', 99], // stays down
    ]);
    const { app, sync } = setup(failures);
    await app.inject({ method: 'POST', url: '/v1/imports', payload: importPayload });
    await sync.idle();
    const status = (
      await app.inject({ url: '/v1/sync/status', headers: { 'x-internal-token': TOKEN } })
    ).json<{
      targets: {
        name: string;
        state: string;
        lastError: string | null;
        pendingInstitutions: string[];
        consecutiveFailures: number;
      }[];
    }>();
    const by = Object.fromEntries(status.targets.map((t) => [t.name, t]));
    expect(by['identity']).toMatchObject({ state: 'ok', pendingInstitutions: [] });
    expect(by['calendar']).toMatchObject({
      state: 'failed',
      consecutiveFailures: 1,
      pendingInstitutions: [INST],
    });
    expect(by['calendar']?.lastError).toContain('/v1/sections returned 503');

    failures.set('calendar:4005', 0);
    const push = await app.inject({
      method: 'POST',
      url: '/v1/sync/push',
      headers: { 'x-internal-token': TOKEN },
      payload: { institutionId: INST, targets: ['calendar'] },
    });
    expect(push.json<{ results: { target: string; ok: boolean }[] }>().results).toEqual([
      { target: 'calendar', ok: true, requests: 2 },
    ]);
    expect(
      (await app.inject({ url: '/v1/sync/status', headers: { 'x-internal-token': TOKEN } }))
        .json<{ targets: { name: string; pendingInstitutions: string[] }[] }>()
        .targets.find((t) => t.name === 'calendar')?.pendingInstitutions,
    ).toEqual([]);
  });

  it('protects sync routes with the internal token and validates input', async () => {
    const { app } = setup();
    expect((await app.inject({ url: '/v1/sync/status' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/sync/push', payload: { institutionId: INST } }))
        .statusCode,
    ).toBe(401);
    const h = { 'x-internal-token': TOKEN };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/sync/push',
          headers: h,
          payload: { institutionId: INST, targets: ['billing'] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/v1/sync/push', headers: h, payload: {} }))
        .statusCode,
    ).toBe(400);
  });
});

describe('alert context feed (integration-stage §6)', () => {
  it('returns class windows with policy rolls, assigned devices and the active device list', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/v1/imports', payload: importPayload });
    const res = await app.inject({
      url: `/internal/v1/alert-context?institutionId=${INST}`,
      headers: { 'x-internal-token': TOKEN },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      now: string;
      classWindows: Record<string, unknown>[];
      devices: Record<string, unknown>[];
      errors: Record<string, string>;
    }>();
    expect(body.now).toBe('2026-11-04T22:30:00.000Z');
    expect(body.classWindows).toEqual([
      expect.objectContaining({
        classroomId: ROOM,
        deviceId: DEVICE,
        institutionId: INST,
        recordStartAt: '2026-11-04T21:55:00.000Z',
        recordStopAt: '2026-11-04T23:50:00.000Z',
        recordingEnabled: true,
      }),
    ]);
    expect(body.devices).toEqual([
      {
        deviceId: DEVICE,
        classroomId: ROOM,
        institutionId: INST,
        lastSeenAt: '2026-11-04T21:59:00.000Z',
        status: 'online',
      },
    ]);
    expect(body.errors).toEqual({});
    const later = (
      await app.inject({
        url: `/internal/v1/alert-context?at=2026-11-06T12:00:00Z&lookbackMinutes=60&lookaheadMinutes=60`,
        headers: { 'x-internal-token': TOKEN },
      })
    ).json<{ classWindows: unknown[] }>();
    expect(later.classWindows).toEqual([]);
    expect((await app.inject({ url: '/internal/v1/alert-context' })).statusCode).toBe(401);
  });
});
