import type { LightMyRequestResponse } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_ID,
  CAMPUS_1,
  INSTITUTION_A,
  INSTITUTION_B,
  ROOM_A1,
  ROOM_A2,
  ROOM_B1,
  adminHeaders,
  assign,
  createHarness,
  healthyMetrics,
  registerDevice,
  signedInject,
  type Harness,
  type TestDevice,
} from './test/helpers.js';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});

const code = (body: string): string => (JSON.parse(body) as { error: { code: string } }).error.code;

const issue = (
  deviceId: string,
  type: string,
  extra: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> =>
  h.app.inject({
    method: 'POST',
    url: `/v1/devices/${deviceId}/commands`,
    headers: adminHeaders,
    payload: { type, requestedBy: ADMIN_ID, ...extra },
  });

interface HeartbeatResponse {
  commands: { commandId: string; type: string; issuedAt: string; expiresAt: string }[];
}

const heartbeat = async (d: TestDevice, metrics = healthyMetrics): Promise<HeartbeatResponse> =>
  (await signedInject(h, d, 'POST', `/v1/devices/${d.deviceId}/heartbeat`, metrics)).json();

const report = (
  d: TestDevice,
  commandId: string,
  body: Record<string, unknown>,
): ReturnType<typeof signedInject> =>
  signedInject(h, d, 'POST', `/v1/devices/${d.deviceId}/commands/${commandId}/result`, body);

describe('remote commands (4.7)', () => {
  it('queues, delivers in the heartbeat response and records a signed result', async () => {
    const d = await registerDevice(h);
    const res = await issue(d.deviceId, 'self_test');
    expect(res.statusCode).toBe(202);
    const { commandId, status } = res.json<{ commandId: string; status: string }>();
    expect(status).toBe('pending');

    const hb = await heartbeat(d);
    expect(hb.commands).toEqual([
      {
        commandId,
        type: 'self_test',
        issuedAt: '2026-11-04T12:00:00.000Z',
        expiresAt: '2026-11-04T12:30:00.000Z',
      },
    ]);
    // Unanswered commands are re-delivered (the device de-duplicates by id).
    expect((await heartbeat(d)).commands).toHaveLength(1);

    const output = { checks: { mic: { ok: true, levelDbfs: -32 }, disk: { ok: true } } };
    const result = await report(d, commandId, {
      status: 'succeeded',
      output,
      finishedAt: h.clock.now().toISOString(),
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      commandId,
      status: 'succeeded',
      output,
      deliveryCount: 2,
    });
    expect((await heartbeat(d)).commands).toEqual([]);

    // Retried identical report is idempotent; a conflicting one is refused.
    const finishedAt = result.json<{ finishedAt: string }>().finishedAt;
    expect((await report(d, commandId, { status: 'succeeded', finishedAt })).statusCode).toBe(200);
    const conflict = await report(d, commandId, { status: 'failed', finishedAt });
    expect(code(conflict.body)).toBe('command_already_finished');

    expect(h.audit.events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['device.command_issued', 'device.command_completed']),
    );
  });

  it('deduplicates open commands of the same type and limits the queue', async () => {
    const d = await registerDevice(h);
    const a = (await issue(d.deviceId, 'reboot')).json<{ commandId: string }>();
    const b = await issue(d.deviceId, 'reboot');
    expect(b.json()).toMatchObject({ commandId: a.commandId, deduplicated: true });

    const small = createHarness({ maxOpenCommandsPerDevice: 2 });
    const built = await registerDevice(small);
    const send = (type: string): Promise<LightMyRequestResponse> =>
      small.app.inject({
        method: 'POST',
        url: `/v1/devices/${built.deviceId}/commands`,
        headers: adminHeaders,
        payload: { type, requestedBy: ADMIN_ID },
      });
    expect((await send('reboot')).statusCode).toBe(202);
    expect((await send('self_test')).statusCode).toBe(202);
    const third = await send('upload_now');
    expect(third.statusCode).toBe(429);
    expect(code(third.body)).toBe('too_many_commands');
    const list = await small.app.inject({
      method: 'GET',
      url: `/v1/devices/${built.deviceId}/commands?status=pending`,
      headers: adminHeaders,
    });
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(2);
  });

  it('expires commands after 30 minutes and never delivers them', async () => {
    const d = await registerDevice(h);
    const { commandId } = (await issue(d.deviceId, 'upload_now')).json<{ commandId: string }>();
    h.clock.advance(30 * 60_000 + 1);
    expect((await heartbeat(d)).commands).toEqual([]);
    const late = await report(d, commandId, {
      status: 'succeeded',
      finishedAt: h.clock.now().toISOString(),
    });
    expect(late.statusCode).toBe(409);
    expect(code(late.body)).toBe('command_not_delivered');
    expect(h.audit.events.filter((e) => e.action === 'device.command_expired')).toHaveLength(1);
  });

  it('accepts a late result for a command delivered before it expired', async () => {
    const d = await registerDevice(h);
    const { commandId } = (await issue(d.deviceId, 'self_test', { ttlMinutes: 5 })).json<{
      commandId: string;
    }>();
    await heartbeat(d);
    h.clock.advance(6 * 60_000);
    const sweep = await h.sweepStatuses();
    expect(sweep.expiredCommands).toBe(1);
    const res = await report(d, commandId, {
      status: 'failed',
      output: 'microphone not found',
      finishedAt: h.clock.now().toISOString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'failed', output: 'microphone not found' });
  });

  it('cancels open commands and rejects results for them', async () => {
    const d = await registerDevice(h);
    const { commandId } = (await issue(d.deviceId, 'rotate_logs')).json<{ commandId: string }>();
    await heartbeat(d);
    const cancel = await h.app.inject({
      method: 'POST',
      url: `/v1/devices/${d.deviceId}/commands/${commandId}/cancel`,
      headers: adminHeaders,
      payload: {},
    });
    expect(cancel.json()).toMatchObject({ status: 'cancelled', cancelledBy: ADMIN_ID });
    expect(
      code(
        (
          await report(d, commandId, {
            status: 'succeeded',
            finishedAt: h.clock.now().toISOString(),
          })
        ).body,
      ),
    ).toBe('command_cancelled');
    const again = await h.app.inject({
      method: 'POST',
      url: `/v1/devices/${d.deviceId}/commands/${commandId}/cancel`,
      headers: adminHeaders,
      payload: {},
    });
    expect(again.statusCode).toBe(409);
  });

  it('requires a signed request from the owning device for results', async () => {
    const a = await registerDevice(h, 'CI-A1-000001');
    const b = await registerDevice(h, 'CI-A1-000002');
    const { commandId } = (await issue(a.deviceId, 'reboot')).json<{ commandId: string }>();
    await heartbeat(a);
    const unsigned = await h.app.inject({
      method: 'POST',
      url: `/v1/devices/${a.deviceId}/commands/${commandId}/result`,
      payload: { status: 'succeeded', finishedAt: h.clock.now().toISOString() },
    });
    expect(unsigned.statusCode).toBe(401);
    // b signs for its own path but references a's command.
    const foreign = await signedInject(
      h,
      b,
      'POST',
      `/v1/devices/${b.deviceId}/commands/${commandId}/result`,
      { status: 'succeeded', finishedAt: h.clock.now().toISOString() },
    );
    expect(foreign.statusCode).toBe(404);
  });

  it('refuses commands for revoked devices and validates types', async () => {
    const d = await registerDevice(h);
    expect((await issue(d.deviceId, 'format_disk')).statusCode).toBe(400);
    await h.app.inject({
      method: 'POST',
      url: `/v1/devices/${d.deviceId}/revoke`,
      headers: adminHeaders,
      payload: { reason: 'stolen device' },
    });
    const res = await issue(d.deviceId, 'reboot');
    expect(res.statusCode).toBe(409);
    expect(code(res.body)).toBe('device_not_active');
  });
});

describe('fleet console (4.7)', () => {
  const seedFleet = async (): Promise<TestDevice[]> => {
    const a = await registerDevice(h, 'CI-A1-000001');
    const b = await registerDevice(h, 'CI-A1-000002');
    const c = await registerDevice(h, 'CI-B1-000001', INSTITUTION_B);
    await assign(h, a.deviceId, ROOM_A1);
    await assign(h, b.deviceId, ROOM_A2);
    await assign(h, c.deviceId, ROOM_B1);
    await heartbeat(a);
    await heartbeat(b, { ...healthyMetrics, firmwareVersion: '1.2.0', isRecording: true });
    await heartbeat(c, { ...healthyMetrics, firmwareVersion: '1.10.0' });
    return [a, b, c];
  };

  type Page = {
    total: number;
    totalPages: number;
    summary: { byStatus: Record<string, number> };
    items: {
      serialNumber: string;
      status: string;
      classroom: { name: string } | null;
      campus: { id: string; name: string } | null;
    }[];
  };
  const fleet = async (qs: string): Promise<Page> =>
    (await h.app.inject({ method: 'GET', url: `/v1/fleet?${qs}`, headers: adminHeaders })).json();

  it('lists with names, filters, sort and paging', async () => {
    await seedFleet();
    const all = await fleet('');
    expect(all.total).toBe(3);
    expect(all.items[0]).toMatchObject({
      serialNumber: 'CI-A1-000001',
      classroom: { name: 'Sala 101' },
      campus: { id: CAMPUS_1, name: 'Campus Paulista' },
    });

    expect((await fleet(`institutionId=${INSTITUTION_A}`)).total).toBe(2);
    expect((await fleet(`campusId=${CAMPUS_1}`)).items.map((i) => i.serialNumber)).toEqual([
      'CI-A1-000001',
      'CI-A1-000002',
    ]);
    expect((await fleet('q=laborat')).items.map((i) => i.serialNumber)).toEqual(['CI-A1-000002']);
    expect((await fleet('q=recife')).items.map((i) => i.serialNumber)).toEqual(['CI-B1-000001']);
    expect((await fleet('firmwareVersion=1.2.0')).total).toBe(1);

    const recording = await fleet('status=recording');
    expect(recording.items.map((i) => i.serialNumber)).toEqual(['CI-A1-000002']);
    expect(recording.summary.byStatus).toMatchObject({ online: 2, recording: 1 });

    expect((await fleet('sort=-firmwareVersion')).items.map((i) => i.serialNumber)).toEqual([
      'CI-B1-000001',
      'CI-A1-000002',
      'CI-A1-000001',
    ]);
    const page2 = await fleet('pageSize=2&page=2');
    expect(page2).toMatchObject({ total: 3, totalPages: 2 });
    expect(page2.items).toHaveLength(1);
    const bad = await h.app.inject({
      method: 'GET',
      url: '/v1/fleet?sort=price',
      headers: adminHeaders,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('degrades gracefully when the organization service is down', async () => {
    await seedFleet();
    h.deps.organization.getClassroom = (): Promise<never> => Promise.reject(new Error('down'));
    const res = await h.app.inject({ method: 'GET', url: '/v1/fleet', headers: adminHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ namesUnavailable: true, total: 3 });
  });

  it('reports the firmware distribution with numeric version ordering', async () => {
    await seedFleet();
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/fleet/firmware',
      headers: adminHeaders,
    });
    expect(res.json()).toMatchObject({
      total: 3,
      latestVersion: '1.10.0',
      outdated: 2,
      versions: [
        { version: '1.10.0', count: 1, isLatest: true },
        { version: '1.2.0', count: 1 },
        { version: '1.0.1', count: 1, percent: 33.3 },
      ],
    });
  });
});

describe('device diagnostics (4.7)', () => {
  it('computes uptime, missed heartbeats, gaps, backlog trend and certificate expiry', async () => {
    // Registered 4 h before "now"; heartbeats every 60 s except a 1 h outage.
    h.clock.current = new Date('2026-11-04T08:00:00.000Z');
    const d = await registerDevice(h);
    await assign(h, d.deviceId, ROOM_A1);
    const minutes = 4 * 60;
    for (let m = 0; m < minutes; m += 1) {
      const inOutage = m >= 60 && m < 120;
      if (!inOutage) {
        await heartbeat(d, { ...healthyMetrics, bufferQueueCount: m >= 180 ? 3 : 0 });
      }
      h.clock.advance(60_000);
    }
    const { commandId } = (await issue(d.deviceId, 'self_test')).json<{ commandId: string }>();

    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/devices/${d.deviceId}/diagnostics`,
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      uptime: {
        uptimePercent: number;
        expectedHeartbeats: number;
        receivedHeartbeats: number;
        missedHeartbeats: number;
        gaps: { durationSeconds: number }[];
        windowStart: string;
      };
      backlogTrend: { samples: number; maxBufferQueueCount: number | null }[];
      certificate: { daysRemaining: number; status: string };
      lastCommands: { commandId: string }[];
      latestHeartbeat: { bufferQueueCount: number } | null;
    }>();
    expect(body.uptime.windowStart).toBe('2026-11-04T08:00:00.000Z');
    expect(body.uptime.expectedHeartbeats).toBe(240);
    expect(body.uptime.receivedHeartbeats).toBe(180);
    expect(body.uptime.missedHeartbeats).toBe(60);
    expect(body.uptime.gaps).toHaveLength(1);
    expect(body.uptime.gaps[0]?.durationSeconds).toBe(61 * 60);
    // Down for the hour minus the 180 s grace after the last heartbeat: ~76 %.
    expect(body.uptime.uptimePercent).toBeGreaterThan(75);
    expect(body.uptime.uptimePercent).toBeLessThan(77);

    expect(body.backlogTrend).toHaveLength(24);
    const lastFour = body.backlogTrend.slice(-4);
    expect(lastFour.map((b) => b.samples)).toEqual([60, 0, 60, 60]);
    expect(lastFour.map((b) => b.maxBufferQueueCount)).toEqual([0, null, 0, 3]);
    expect(body.certificate).toMatchObject({ status: 'valid', daysRemaining: 364 });
    expect(body.lastCommands.map((c) => c.commandId)).toEqual([commandId]);
    expect(body.latestHeartbeat?.bufferQueueCount).toBe(3);
  });

  it('reports a device that never sent a heartbeat as fully down', async () => {
    const d = await registerDevice(h);
    h.clock.advance(3_600_000);
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/devices/${d.deviceId}/diagnostics?windowHours=2`,
      headers: adminHeaders,
    });
    expect(res.json()).toMatchObject({
      latestHeartbeat: null,
      uptime: { uptimePercent: 0, receivedHeartbeats: 0, expectedHeartbeats: 60 },
    });
    expect(res.json<{ backlogTrend: unknown[] }>().backlogTrend).toHaveLength(2);
  });
});
