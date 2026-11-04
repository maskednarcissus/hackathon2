import { generateKeyPairSync, randomUUID, sign as edSign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { InMemoryAuditClient } from './audit.js';
import { HttpOrganizationClient, MapOrganizationClient } from './incidents/organization.js';
import { createAccessTokenVerifier } from './vendor/jwt-verify.js';

/** Response bodies used in assertions (typed for lint; fields are a superset). */
interface Body {
  error: { code: string };
  comment: unknown;
  incident: { comments: unknown[] };
  timeline: { action: string }[];
  count: number;
  items: unknown[];
}

const INST = '6f1c2e8a-1b2c-4d5e-8f90-1234567890ab';
const OTHER_INST = '7f1c2e8a-1b2c-4d5e-8f90-1234567890ab';
const T0 = new Date('2026-11-04T12:00:00.000Z');
const min = (m: number): string => new Date(T0.getTime() + m * 60_000).toISOString();

function setup(opts: { adminToken?: string; verifyKey?: KeyObject } = {}) {
  let now = T0;
  const org = new MapOrganizationClient();
  org.classrooms.set('room-1', {
    classroomId: 'room-1',
    classroomName: 'Sala 101',
    campusId: 'campus-norte',
    campusName: 'Campus Norte',
    institutionId: INST,
  });
  org.classrooms.set('room-2', {
    classroomId: 'room-2',
    classroomName: 'Auditório',
    campusId: 'campus-sul',
    campusName: 'Campus Sul',
    institutionId: INST,
  });
  const audit = new InMemoryAuditClient();
  const { app } = buildApp({
    clock: () => now,
    organization: org,
    audit,
    ...(opts.adminToken ? { adminToken: opts.adminToken } : {}),
    ...(opts.verifyKey
      ? {
          verifyToken: createAccessTokenVerifier({
            getKey: () => Promise.resolve(opts.verifyKey!),
          }),
        }
      : {}),
  });
  const req = (
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  const window = (id: string, classroomId: string, startMin = 0) => ({
    scheduledClassId: id,
    classroomId,
    recordStartAt: min(startMin),
    recordStopAt: min(startMin + 100),
  });
  const evaluate = (nowIso: string, body: object) =>
    req('POST', '/v1/alerts/evaluate', { now: nowIso, ...body });
  /** recording_missed (high) for class-A in room-1, low_storage (medium) in room-2. */
  const seed = async () => {
    await evaluate(min(5), {
      classWindows: [window('class-A', 'room-1')],
      devices: [
        { deviceId: 'dev-2', classroomId: 'room-2', lastSeenAt: min(5), diskFreeBytes: 10 },
      ],
    });
    const list = (await req('GET', '/v1/incidents')).json<{
      items: ({ id: string; type: string } & Record<string, unknown>)[];
    }>();
    return {
      missed: list.items.find((i) => i.type === 'recording_missed')!,
      storage: list.items.find((i) => i.type === 'low_storage')!,
    };
  };
  return {
    app,
    org,
    audit,
    req,
    evaluate,
    window,
    seed,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
  };
}

describe('incident queue (4.8)', () => {
  it('lists incidents with campus resolved from the classroom, SLA and contract fields', async () => {
    const t = setup();
    const { missed, storage } = await t.seed();
    expect(missed).toMatchObject({
      type: 'recording_missed',
      severity: 'high',
      status: 'open',
      classroomId: 'room-1',
      classroomName: 'Sala 101',
      campusId: 'campus-norte',
      campusName: 'Campus Norte',
      institutionId: INST,
      assigneeId: null,
      openedAt: min(5),
      slaDueAt: min(5 + 240),
      slaBreached: false,
    });
    expect(storage).toMatchObject({ severity: 'medium', slaDueAt: min(5 + 24 * 60) });
    // classroom lookup cached per alert creation only (not on every repeat)
    const calls = t.org.calls;
    await t.evaluate(min(6), { classWindows: [t.window('class-A', 'room-1')] });
    expect(t.org.calls).toBe(calls);
  });

  it('filters by status, severity, type, campus, assignee and institution; sorts by severity or age', async () => {
    const t = setup();
    const { missed, storage } = await t.seed();
    const ids = async (qs: string) =>
      (await t.req('GET', `/v1/incidents${qs}`))
        .json<{ items: { id: string }[] }>()
        .items.map((i) => i.id);
    expect(await ids('?campusId=campus-sul')).toEqual([storage.id]);
    expect(await ids('?severity=high')).toEqual([missed.id]);
    expect(await ids('?type=low_storage')).toEqual([storage.id]);
    expect(await ids(`?institutionId=${INST}`)).toHaveLength(2);
    expect(await ids(`?institutionId=${OTHER_INST}`)).toEqual([]);
    expect(await ids('?sort=severity')).toEqual([missed.id, storage.id]);

    await t.req('POST', `/v1/incidents/${storage.id}/assign`, {
      assigneeId: 'tech-1',
      actorId: 'coord-1',
    });
    expect(await ids('?assignee=tech-1')).toEqual([storage.id]);
    expect(await ids('?assignee=unassigned')).toEqual([missed.id]);

    // a newer, more severe incident: severity sort puts it first, age sort puts it last
    t.setNow(min(30));
    await t.evaluate(min(30), {
      devices: [{ deviceId: 'dev-9', classroomId: 'room-2', lastSeenAt: min(0) }],
      classWindows: [t.window('class-B', 'room-2', 20)],
    });
    const bySeverity = await ids('?sort=severity&status=open');
    const byAge = await ids('?sort=age&status=open');
    expect(bySeverity[bySeverity.length - 1]).not.toBe(byAge[byAge.length - 1]);
    expect(byAge.slice(0, 2).sort()).toEqual([missed.id, storage.id].sort()); // both raised at +5
    const bad = await t.req('GET', '/v1/incidents?status=closed');
    expect(bad.statusCode).toBe(400);
  });

  it('assign, in_progress, comments and resolution with a required code; full timeline + audit', async () => {
    const t = setup();
    const { missed } = await t.seed();
    t.setNow(min(15));
    const assigned = await t.req('POST', `/v1/incidents/${missed.id}/assign`, {
      assigneeId: 'tech-1',
      actorId: 'coord-1',
    });
    expect(assigned.json<Body>()).toMatchObject({
      assigneeId: 'tech-1',
      assignedAt: min(15),
      status: 'open',
    });

    t.setNow(min(20));
    const progress = await t.req('POST', `/v1/incidents/${missed.id}/status`, {
      status: 'in_progress',
      actorId: 'tech-1',
    });
    expect(progress.json<Body>()).toMatchObject({
      status: 'in_progress',
      inProgressAt: min(20),
      acknowledgedAt: min(20),
      assigneeId: 'tech-1',
    });

    const c = await t.req('POST', `/v1/incidents/${missed.id}/comments`, {
      actorId: 'tech-1',
      body: 'Cabo de rede desconectado na sala 101.',
    });
    expect(c.statusCode).toBe(201);
    expect(c.json<Body>().comment).toMatchObject({
      actorId: 'tech-1',
      body: 'Cabo de rede desconectado na sala 101.',
    });
    expect(c.json<Body>().incident.comments).toHaveLength(1);
    expect(
      (await t.req('POST', `/v1/incidents/${missed.id}/comments`, { actorId: 'x', body: '  ' }))
        .statusCode,
    ).toBe(400);

    const noCode = await t.req('POST', `/v1/incidents/${missed.id}/status`, {
      status: 'resolved',
      actorId: 'tech-1',
    });
    expect(noCode.statusCode).toBe(422);
    expect(noCode.json<Body>().error.code).toBe('resolution_code_required');
    const badCode = await t.req('POST', `/v1/incidents/${missed.id}/status`, {
      status: 'resolved',
      actorId: 'tech-1',
      resolutionCode: 'magic',
    });
    expect(badCode.statusCode).toBe(400);

    t.setNow(min(65));
    const resolved = await t.req('POST', `/v1/incidents/${missed.id}/status`, {
      status: 'resolved',
      actorId: 'tech-1',
      resolutionCode: 'network_fixed',
      note: 'Cabo substituído',
    });
    expect(resolved.json<Body>()).toMatchObject({
      status: 'resolved',
      resolution: 'manual',
      resolutionCode: 'network_fixed',
      resolutionNote: 'Cabo substituído',
      resolvedBy: 'tech-1',
      slaBreached: false,
      ageMinutes: 60,
    });
    const detail = (await t.req('GET', `/v1/incidents/${missed.id}`)).json<Body>();
    expect(detail.timeline.map((e: { action: string }) => e.action)).toEqual([
      'raised',
      'assigned',
      'in_progress',
      'commented',
      'resolved',
    ]);
    expect(t.audit.events.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'alert.raised',
        'alert.assigned',
        'alert.in_progress',
        'alert.commented',
        'alert.resolved',
      ]),
    );
    expect(t.audit.events.find((e) => e.action === 'alert.resolved')!.metadata).toMatchObject({
      resolutionCode: 'network_fixed',
    });

    // resolved incidents are closed for workflow changes
    expect(
      (await t.req('POST', `/v1/incidents/${missed.id}/assign`, { assigneeId: 'x', actorId: 'y' }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await t.req('POST', `/v1/incidents/${missed.id}/status`, {
          status: 'in_progress',
          actorId: 'y',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('acknowledged → in_progress; escalation keeps in_progress and tightens the SLA', async () => {
    const t = setup();
    const dev = { deviceId: 'dev-1', classroomId: 'room-1', lastSeenAt: min(0) };
    await t.evaluate(min(6), { devices: [dev] }); // low (outside class)
    const [inc] = (await t.req('GET', '/v1/incidents')).json<{
      items: { id: string; slaDueAt: string }[];
    }>().items;
    expect(inc!.slaDueAt).toBe(min(6 + 72 * 60));
    const ack = await t.req('POST', `/v1/incidents/${inc!.id}/status`, {
      status: 'acknowledged',
      actorId: 'c',
    });
    expect(ack.json<Body>()).toMatchObject({ status: 'acknowledged', acknowledgedBy: 'c' });
    await t.req('POST', `/v1/incidents/${inc!.id}/status`, {
      status: 'in_progress',
      actorId: 'tech',
    });
    // class starts while still offline → high
    await t.evaluate(min(20), {
      devices: [dev],
      classWindows: [t.window('class-Z', 'room-1', 15)],
    });
    const after = (await t.req('GET', `/v1/incidents/${inc!.id}`)).json<Body>();
    expect(after).toMatchObject({
      severity: 'high',
      status: 'in_progress',
      slaDueAt: min(6 + 240),
    });
    expect(after.timeline.map((e: { action: string }) => e.action)).toContain('escalated');
    const backToAck = await t.req('POST', `/v1/incidents/${inc!.id}/status`, {
      status: 'acknowledged',
      actorId: 'c',
    });
    expect(backToAck.statusCode).toBe(409);
  });

  it('SLA breach and stats: MTTA, MTTR, open by severity, breaches within from/to', async () => {
    const t = setup();
    const { missed, storage } = await t.seed(); // raised at +5
    t.setNow(min(35));
    await t.req('POST', `/v1/incidents/${missed.id}/status`, {
      status: 'acknowledged',
      actorId: 'c',
    }); // 30 min
    t.setNow(min(5 + 300));
    await t.req('POST', `/v1/incidents/${missed.id}/status`, {
      status: 'resolved',
      actorId: 'c',
      resolutionCode: 'class_cancelled',
    }); // 300 min > 4 h SLA → breached
    t.setNow(min(5 + 25 * 60)); // storage (24 h SLA) now overdue
    const list = (await t.req('GET', '/v1/incidents')).json<{
      items: { id: string; slaBreached: boolean }[];
    }>();
    expect(list.items.find((i) => i.id === storage.id)!.slaBreached).toBe(true);
    expect(list.items.find((i) => i.id === missed.id)!.slaBreached).toBe(true);

    const stats = await t.req(
      'GET',
      `/v1/incidents/stats?institutionId=${INST}&from=${min(0)}&to=${min(60)}`,
    );
    expect(stats.statusCode).toBe(200);
    expect(stats.json<Body>()).toMatchObject({
      institutionId: INST,
      mttaMinutes: 30,
      mttrMinutes: 300,
      openBySeverity: { critical: 0, high: 0, medium: 1, low: 0 },
      openTotal: 1,
      slaBreaches: 2,
      raised: 2,
      resolved: 1,
      byType: { recording_missed: 1, low_storage: 1 },
    });
    const empty = await t.req('GET', `/v1/incidents/stats?from=${min(100)}&to=${min(200)}`);
    expect(empty.json<Body>()).toMatchObject({
      mttaMinutes: null,
      mttrMinutes: null,
      raised: 0,
      openTotal: 1,
    });
    expect(
      (await t.req('GET', `/v1/incidents/stats?from=${min(10)}&to=${min(5)}`)).statusCode,
    ).toBe(400);
    expect((await t.req('GET', '/v1/incidents/stats')).statusCode).toBe(400);
  });

  it('auto-resolved incidents keep no resolution code; Phase 1 alert API still works', async () => {
    const t = setup();
    const { missed } = await t.seed();
    await t.req('POST', '/v1/lifecycle-events', {
      eventId: randomUUID(),
      type: 'recording.started',
      version: 1,
      occurredAt: min(6),
      source: 't',
      institutionId: INST,
      data: { scheduledClassId: 'class-A' },
    });
    const inc = (await t.req('GET', `/v1/incidents/${missed.id}`)).json<Body>();
    expect(inc).toMatchObject({ status: 'resolved', resolution: 'auto', resolutionCode: null });
    expect((await t.req('GET', '/v1/alerts?status=resolved')).json<Body>().count).toBe(1);
  });

  it('404 for unknown incident ids', async () => {
    const t = setup();
    expect((await t.req('GET', `/v1/incidents/${randomUUID()}`)).statusCode).toBe(404);
    expect(
      (
        await t.req('POST', `/v1/incidents/${randomUUID()}/assign`, {
          assigneeId: 'a',
          actorId: 'b',
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('incident auth', () => {
  it('requires the static ADMIN_API_TOKEN when configured', async () => {
    const t = setup({ adminToken: 'admin-secret' });
    expect((await t.req('GET', '/v1/incidents')).statusCode).toBe(401);
    expect(
      (await t.req('GET', '/v1/incidents', undefined, { authorization: 'Bearer nope' })).statusCode,
    ).toBe(401);
    expect(
      (await t.req('GET', '/v1/incidents', undefined, { authorization: 'Bearer admin-secret' }))
        .statusCode,
    ).toBe(200);
    expect((await t.req('GET', '/v1/alerts')).statusCode).toBe(401);
  });

  it('accepts coordinator/admin identity JWTs scoped to their institution; acts as the token subject', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const token = (role: string, inst: string, sub = 'coord-jwt') => {
      const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const h = enc({ alg: 'EdDSA', typ: 'JWT' });
      const b = enc({
        iss: 'ci-identity',
        aud: 'ci',
        sub,
        iat: now,
        exp: now + 600,
        jti: randomUUID(),
        inst,
        role,
        pid: randomUUID(),
      });
      return `Bearer ${h}.${b}.${edSign(null, Buffer.from(`${h}.${b}`), privateKey).toString('base64url')}`;
    };
    const t = setup({ adminToken: 'admin-secret', verifyKey: publicKey });
    const admin = { authorization: 'Bearer admin-secret' };
    await t.evaluate(min(5), { classWindows: [t.window('class-A', 'room-1')] });
    const [inc] = (await t.req('GET', '/v1/incidents', undefined, admin)).json<{
      items: { id: string }[];
    }>().items;

    expect(
      (await t.req('GET', '/v1/incidents', undefined, { authorization: token('student', INST) }))
        .statusCode,
    ).toBe(403);
    const mine = await t.req('GET', '/v1/incidents', undefined, {
      authorization: token('coordinator', INST),
    });
    expect(mine.json<Body>().items).toHaveLength(1);
    const other = { authorization: token('admin', OTHER_INST) };
    expect((await t.req('GET', '/v1/incidents', undefined, other)).json<Body>().items).toHaveLength(
      0,
    );
    expect(
      (await t.req('GET', `/v1/incidents?institutionId=${INST}`, undefined, other)).statusCode,
    ).toBe(403);
    expect((await t.req('GET', `/v1/incidents/${inc!.id}`, undefined, other)).statusCode).toBe(404);

    const assigned = await t.req(
      'POST',
      `/v1/incidents/${inc!.id}/assign`,
      { assigneeId: 'tech-1', actorId: 'spoofed' },
      { authorization: token('coordinator', INST) },
    );
    expect(assigned.statusCode).toBe(200);
    expect(t.audit.events.find((e) => e.action === 'alert.assigned')!.actorId).toBe('coord-jwt');
  });
});

describe('HttpOrganizationClient', () => {
  it('resolves classroom → campus, caches hits and misses, tolerates errors', async () => {
    const calls: string[] = [];
    let fail = false;
    const fetchImpl = ((url: string) => {
      calls.push(url);
      if (fail) return Promise.resolve(new Response('boom', { status: 503 }));
      if (url.endsWith('/v1/classrooms/room-1')) {
        return Promise.resolve(
          Response.json({ id: 'room-1', name: 'Sala 101', campusId: 'c1', institutionId: INST }),
        );
      }
      if (url.endsWith('/v1/campuses/c1'))
        return Promise.resolve(Response.json({ id: 'c1', name: 'Campus Norte' }));
      return Promise.resolve(new Response('{}', { status: 404 }));
    }) as unknown as typeof fetch;
    let now = 0;
    const client = new HttpOrganizationClient('http://org/', {
      fetchImpl,
      now: () => now,
      ttlMs: 1000,
      negativeTtlMs: 100,
    });
    expect(await client.locateClassroom('room-1')).toEqual({
      classroomId: 'room-1',
      classroomName: 'Sala 101',
      campusId: 'c1',
      campusName: 'Campus Norte',
      institutionId: INST,
    });
    await client.locateClassroom('room-1');
    expect(calls).toEqual(['http://org/v1/classrooms/room-1', 'http://org/v1/campuses/c1']);
    expect(await client.locateClassroom('missing')).toBeUndefined();
    await client.locateClassroom('missing');
    expect(calls.filter((c) => c.includes('missing'))).toHaveLength(1);
    now = 2000;
    fail = true;
    expect(await client.locateClassroom('room-1')).toBeUndefined(); // expired + error → undefined, not cached
    fail = false;
    expect((await client.locateClassroom('room-1'))?.campusId).toBe('c1');
  });
});
