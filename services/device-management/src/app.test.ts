import { beforeEach, describe, expect, it } from 'vitest';
import { verifyCertificate } from './crypto.js';
import {
  ADMIN_ID,
  INSTITUTION_A,
  INSTITUTION_B,
  ROOM_A1,
  ROOM_A2,
  ROOM_B1,
  adminHeaders,
  assign,
  createHarness,
  createToken,
  healthyMetrics,
  newKeyPair,
  registerDevice,
  signedInject,
  type Harness,
} from './test/helpers.js';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});

type ErrorBody = { error: { code: string } };
const code = (body: string): string => (JSON.parse(body) as ErrorBody).error.code;

describe('1.1 provisioning & registration', () => {
  it('registers a device with a valid token and issues a CA-signed certificate', async () => {
    const device = await registerDevice(h);
    const payload = verifyCertificate(device.certificate, h.deps.ca.publicKey);
    expect(payload).toMatchObject({
      v: 1,
      deviceId: device.deviceId,
      serialNumber: 'CI-A1-000123',
      institutionId: INSTITUTION_A,
      issuer: 'ci-device-ca',
      expiresAt: '2027-11-04T12:00:00.000Z',
    });
    expect(payload?.publicKeyFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(h.audit.events.map((e) => e.action)).toEqual([
      'device.provisioning_token_created',
      'device.registered',
    ]);
    expect(h.events.events.map((e) => e.type)).toEqual(['device.registered']);
  });

  it('stores only the SHA-256 hash of provisioning tokens', async () => {
    const token = await createToken(h, 'CI-A1-000999');
    expect(token).toMatch(/^pt_/);
    expect(await h.repo.findTokenByHash(token)).toBeUndefined();
    expect(JSON.stringify(h.audit.events)).not.toContain(token);
  });

  it('rejects a reused token', async () => {
    const token = await createToken(h, 'CI-A1-000777');
    const reg = (publicKeyPem: string): Promise<{ statusCode: number; body: string }> =>
      h.app.inject({
        method: 'POST',
        url: '/v1/devices/register',
        payload: {
          provisioningToken: token,
          serialNumber: 'CI-A1-000777',
          model: 'ci-capture-a1',
          firmwareVersion: '1',
          publicKeyPem,
        },
      });
    expect((await reg(newKeyPair().publicKeyPem)).statusCode).toBe(201);
    const second = await reg(newKeyPair().publicKeyPem);
    expect(second.statusCode).toBe(401);
    expect(code(second.body)).toBe('provisioning_token_used');
  });

  it('rejects expired, unknown and serial-mismatched tokens', async () => {
    const token = await createToken(h, 'CI-A1-000555', INSTITUTION_A, 1);
    const attempt = (
      provisioningToken: string,
      serialNumber = 'CI-A1-000555',
    ): Promise<{ statusCode: number; body: string }> =>
      h.app.inject({
        method: 'POST',
        url: '/v1/devices/register',
        payload: {
          provisioningToken,
          serialNumber,
          model: 'ci-capture-a1',
          firmwareVersion: '1',
          publicKeyPem: newKeyPair().publicKeyPem,
        },
      });

    const mismatch = await attempt(token, 'CI-A1-000556');
    expect(mismatch.statusCode).toBe(403);
    expect(code(mismatch.body)).toBe('provisioning_token_serial_mismatch');

    const unknown = await attempt('pt_doesnotexistdoesnotexist');
    expect(unknown.statusCode).toBe(401);
    expect(code(unknown.body)).toBe('invalid_provisioning_token');

    h.clock.advance(3_600_001);
    const expired = await attempt(token);
    expect(expired.statusCode).toBe(401);
    expect(code(expired.body)).toBe('provisioning_token_expired');
  });

  it('rejects non-Ed25519 keys', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ format: 'pem', type: 'spki' })
      .toString();
    const token = await createToken(h, 'CI-A1-000444');
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/register',
      payload: {
        provisioningToken: token,
        serialNumber: 'CI-A1-000444',
        model: 'ci-capture-a1',
        firmwareVersion: '1',
        publicKeyPem: rsa,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(code(res.body)).toBe('invalid_public_key');
  });

  it('refuses tokens for serials that are already actively registered', async () => {
    await registerDevice(h);
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/provisioning-tokens',
      headers: adminHeaders,
      payload: { serialNumber: 'CI-A1-000123', institutionId: INSTITUTION_A },
    });
    expect(res.statusCode).toBe(409);
  });

  it('re-provisions a revoked device keeping its id', async () => {
    const device = await registerDevice(h);
    await h.app.inject({
      method: 'POST',
      url: `/v1/devices/${device.deviceId}/revoke`,
      headers: adminHeaders,
      payload: { reason: 'lost key' },
    });
    const again = await registerDevice(h);
    expect(again.deviceId).toBe(device.deviceId);
  });

  it('requires the admin bearer token on admin routes', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/provisioning-tokens',
      payload: { serialNumber: 'X-1', institutionId: INSTITUTION_A },
    });
    expect(res.statusCode).toBe(401);
    expect(code(res.body)).toBe('admin_auth_required');
    const fleet = await h.app.inject({
      method: 'GET',
      url: '/v1/fleet/health',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(fleet.statusCode).toBe(401);
  });

  it('returns structured errors for invalid JSON and invalid payloads', async () => {
    const bad = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/register',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(bad.statusCode).toBe(400);
    expect(code(bad.body)).toBe('invalid_json');
    const invalid = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/register',
      payload: { serialNumber: 'x' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(code(invalid.body)).toBe('validation_error');
  });
});

describe('1.2 classroom mapping & tenant association', () => {
  it('assigns, reassigns (closing the previous assignment) and audits', async () => {
    const device = await registerDevice(h);
    const first = await assign(h, device.deviceId, ROOM_A1);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      changed: true,
      assignment: { classroomId: ROOM_A1, institutionId: INSTITUTION_A, assignedBy: ADMIN_ID },
    });

    expect((await assign(h, device.deviceId, ROOM_A1)).json()).toMatchObject({ changed: false });
    expect((await assign(h, device.deviceId, ROOM_A2)).statusCode).toBe(200);

    const history = (
      await h.app.inject({
        method: 'GET',
        url: `/v1/devices/${device.deviceId}/assignments`,
        headers: adminHeaders,
      })
    ).json<{ items: { classroomId: string; unassignedAt?: string }[] }>().items;
    expect(history).toHaveLength(2);
    expect(history.find((a) => a.classroomId === ROOM_A1)?.unassignedAt).toBeDefined();
    expect(history.find((a) => a.classroomId === ROOM_A2)?.unassignedAt).toBeUndefined();

    const assigned = h.audit.events.filter((e) => e.action === 'device.assigned');
    expect(assigned[1]?.metadata).toMatchObject({
      classroomId: ROOM_A2,
      previousClassroomId: ROOM_A1,
    });
    expect(h.events.events.filter((e) => e.type === 'device.assigned')[1]?.data).toMatchObject({
      previousClassroomId: ROOM_A1,
    });
  });

  it('rejects classrooms of another institution and unknown classrooms', async () => {
    const device = await registerDevice(h);
    const cross = await assign(h, device.deviceId, ROOM_B1);
    expect(cross.statusCode).toBe(409);
    expect(code(cross.body)).toBe('tenant_mismatch');
    const unknown = await assign(h, device.deviceId, 'aaaaaaaa-0000-4000-8000-00000000ffff');
    expect(unknown.statusCode).toBe(404);
  });

  it('allows only one active device per classroom', async () => {
    const a = await registerDevice(h, 'CI-A1-000001');
    const b = await registerDevice(h, 'CI-A1-000002');
    await assign(h, a.deviceId, ROOM_A1);
    const res = await assign(h, b.deviceId, ROOM_A1);
    expect(res.statusCode).toBe(409);
    expect(code(res.body)).toBe('classroom_occupied');
  });

  it('unassigns a device', async () => {
    const device = await registerDevice(h);
    await assign(h, device.deviceId, ROOM_A1);
    const res = await h.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${device.deviceId}/assignment`,
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(204);
    const key = (
      await h.app.inject({
        method: 'GET',
        url: `/internal/v1/devices/${device.deviceId}/public-key`,
      })
    ).json<{ classroomId: string | null }>();
    expect(key.classroomId).toBeNull();
  });
});

describe('1.3 signed device requests', () => {
  it('accepts a correctly signed heartbeat', async () => {
    const device = await registerDevice(h);
    await assign(h, device.deviceId, ROOM_A1);
    const res = await signedInject(
      h,
      device,
      'POST',
      `/v1/devices/${device.deviceId}/heartbeat`,
      healthyMetrics,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'online', issues: [], classroomId: ROOM_A1 });
  });

  it('rejects a bad signature, tampered body, clock skew and missing headers', async () => {
    const device = await registerDevice(h);
    const url = `/v1/devices/${device.deviceId}/heartbeat`;

    const wrongKey = await signedInject(h, device, 'POST', url, healthyMetrics, {
      privateKey: newKeyPair().privateKey,
    });
    expect(wrongKey.statusCode).toBe(401);
    expect(code(wrongKey.body)).toBe('invalid_signature');

    const tampered = await signedInject(h, device, 'POST', url, healthyMetrics, {
      tamperBody: JSON.stringify({ ...healthyMetrics, cpuTempC: 10 }),
    });
    expect(code(tampered.body)).toBe('invalid_signature');

    const skewed = await signedInject(h, device, 'POST', url, healthyMetrics, {
      timestamp: new Date(h.clock.now().getTime() - 301_000).toISOString(),
    });
    expect(skewed.statusCode).toBe(401);
    expect(code(skewed.body)).toBe('clock_skew');

    const missing = await h.app.inject({ method: 'POST', url, payload: healthyMetrics });
    expect(missing.statusCode).toBe(401);
    expect(code(missing.body)).toBe('device_auth_required');
  });

  it('rejects a device acting on another device', async () => {
    const a = await registerDevice(h, 'CI-A1-000001');
    const b = await registerDevice(h, 'CI-A1-000002');
    const res = await signedInject(
      h,
      a,
      'POST',
      `/v1/devices/${b.deviceId}/heartbeat`,
      healthyMetrics,
    );
    expect(res.statusCode).toBe(403);
    expect(code(res.body)).toBe('device_mismatch');
  });

  it('rejects revoked devices and exposes their status to other services', async () => {
    const device = await registerDevice(h);
    const revoke = await h.app.inject({
      method: 'POST',
      url: `/v1/devices/${device.deviceId}/revoke`,
      headers: adminHeaders,
      payload: { reason: 'device stolen' },
    });
    expect(revoke.statusCode).toBe(200);
    expect(h.audit.events.at(-1)?.action).toBe('device.certificate_revoked');

    const res = await signedInject(
      h,
      device,
      'POST',
      `/v1/devices/${device.deviceId}/heartbeat`,
      healthyMetrics,
    );
    expect(res.statusCode).toBe(403);
    expect(code(res.body)).toBe('device_revoked');

    const key = await h.app.inject({
      method: 'GET',
      url: `/internal/v1/devices/${device.deviceId}/public-key`,
    });
    expect(key.json()).toMatchObject({
      deviceId: device.deviceId,
      status: 'revoked',
      institutionId: INSTITUTION_A,
    });
    expect(key.json<{ publicKeyPem: string }>().publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });

  it('rejects unknown devices', async () => {
    const device = await registerDevice(h);
    const res = await signedInject(
      h,
      device,
      'POST',
      `/v1/devices/${device.deviceId}/heartbeat`,
      healthyMetrics,
      {
        deviceId: '99999999-9999-4999-8999-999999999999',
      },
    );
    expect(res.statusCode).toBe(401);
    expect(code(res.body)).toBe('unknown_device');
  });
});

describe('heartbeats, derived status and fleet health', () => {
  it('derives attention_required and recording from heartbeat metrics', async () => {
    const device = await registerDevice(h);
    await assign(h, device.deviceId, ROOM_A1);
    const url = `/v1/devices/${device.deviceId}/heartbeat`;

    const rec = await signedInject(h, device, 'POST', url, {
      ...healthyMetrics,
      isRecording: true,
    });
    expect(rec.json()).toMatchObject({ status: 'recording' });

    const hot = await signedInject(h, device, 'POST', url, {
      ...healthyMetrics,
      cpuTempC: 85,
      diskFreeBytes: 512 * 1024 ** 2,
      bufferQueueCount: 25,
    });
    expect(hot.json()).toMatchObject({
      status: 'attention_required',
      issues: ['low_disk', 'high_temperature', 'upload_backlog'],
    });

    const changes = h.audit.events
      .filter((e) => e.action === 'device.status_changed')
      .map((e) => e.metadata?.['to']);
    expect(changes).toEqual(['recording', 'attention_required']);
  });

  it('marks devices offline after 180 s and emits device.heartbeat_missed once', async () => {
    const device = await registerDevice(h);
    await assign(h, device.deviceId, ROOM_A1);
    await signedInject(
      h,
      device,
      'POST',
      `/v1/devices/${device.deviceId}/heartbeat`,
      healthyMetrics,
    );

    h.clock.advance(170_000);
    expect((await h.sweepStatuses()).transitions).toEqual([]);

    h.clock.advance(20_000);
    const sweep = await h.sweepStatuses();
    expect(sweep.transitions).toEqual([
      { deviceId: device.deviceId, from: 'online', to: 'offline' },
    ]);
    expect((await h.sweepStatuses()).transitions).toEqual([]);
    const missed = h.events.events.filter((e) => e.type === 'device.heartbeat_missed');
    expect(missed).toHaveLength(1);
    expect(missed[0]?.data).toMatchObject({
      deviceId: device.deviceId,
      classroomId: ROOM_A1,
      lastSeenAt: '2026-11-04T12:00:00.000Z',
    });
  });

  it('summarises the fleet and filters by status', async () => {
    const a = await registerDevice(h, 'CI-A1-000001');
    const b = await registerDevice(h, 'CI-A1-000002');
    await registerDevice(h, 'CI-B1-000001', INSTITUTION_B);
    await assign(h, a.deviceId, ROOM_A1);
    await assign(h, b.deviceId, ROOM_A2);
    await signedInject(h, a, 'POST', `/v1/devices/${a.deviceId}/heartbeat`, healthyMetrics);
    await signedInject(h, b, 'POST', `/v1/devices/${b.deviceId}/heartbeat`, {
      ...healthyMetrics,
      isRecording: true,
    });

    const fleet = await h.app.inject({
      method: 'GET',
      url: `/v1/fleet/health?institutionId=${INSTITUTION_A}`,
      headers: adminHeaders,
    });
    expect(fleet.statusCode).toBe(200);
    const body = fleet.json<{
      summary: { total: number; byStatus: Record<string, number> };
      devices: {
        serialNumber: string;
        status: string;
        classroomId: string;
        metrics: { cpuTempC: number } | null;
      }[];
    }>();
    expect(body.summary.total).toBe(2);
    expect(body.summary.byStatus).toMatchObject({ online: 1, recording: 1, offline: 0 });
    expect(body.devices.map((d) => d.serialNumber)).toEqual(['CI-A1-000001', 'CI-A1-000002']);
    expect(body.devices[0]?.metrics?.cpuTempC).toBe(52.5);

    const all = (
      await h.app.inject({
        method: 'GET',
        url: '/v1/fleet/health?status=offline',
        headers: adminHeaders,
      })
    ).json<{
      summary: { total: number };
      devices: { serialNumber: string; issues: string[] }[];
    }>();
    expect(all.summary.total).toBe(3);
    expect(all.devices.map((d) => d.serialNumber)).toEqual(['CI-B1-000001']);
    expect(all.devices[0]?.issues).toEqual(expect.arrayContaining(['no_heartbeat', 'unassigned']));
  });

  it('returns heartbeat history for a device', async () => {
    const device = await registerDevice(h);
    for (let i = 0; i < 3; i += 1) {
      await signedInject(h, device, 'POST', `/v1/devices/${device.deviceId}/heartbeat`, {
        ...healthyMetrics,
        uptimeSeconds: i,
      });
      h.clock.advance(60_000);
    }
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/devices/${device.deviceId}/health?limit=2`,
      headers: adminHeaders,
    });
    const body = res.json<{ heartbeats: { uptimeSeconds: number }[] }>();
    expect(body.heartbeats.map((x) => x.uptimeSeconds)).toEqual([2, 1]);
  });

  it('maintenance mode overrides derived status', async () => {
    const device = await registerDevice(h);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/v1/devices/${device.deviceId}/maintenance`,
      headers: adminHeaders,
      payload: { enabled: true },
    });
    expect(res.json()).toMatchObject({ maintenanceMode: true, status: 'maintenance' });
  });

  it('validates heartbeat payloads', async () => {
    const device = await registerDevice(h);
    const res = await signedInject(h, device, 'POST', `/v1/devices/${device.deviceId}/heartbeat`, {
      ...healthyMetrics,
      cpuTempC: 'hot',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('recording plan proxy', () => {
  it('requires an assignment, then proxies academic-integration with a signed query string', async () => {
    const device = await registerDevice(h);
    const unassigned = await signedInject(
      h,
      device,
      'GET',
      `/v1/devices/${device.deviceId}/recording-plan`,
    );
    expect(unassigned.statusCode).toBe(409);
    expect(code(unassigned.body)).toBe('device_unassigned');

    await assign(h, device.deviceId, ROOM_A1);
    const from = '2026-11-04T12:00:00.000Z';
    const to = '2026-11-05T12:00:00.000Z';
    const res = await signedInject(
      h,
      device,
      'GET',
      `/v1/devices/${device.deviceId}/recording-plan?from=${from}&to=${to}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ classroomId: ROOM_A1, windows: [] });
    expect(h.schedule.calls).toEqual([{ classroomId: ROOM_A1, from, to }]);

    const tooLong = await signedInject(
      h,
      device,
      'GET',
      `/v1/devices/${device.deviceId}/recording-plan?from=${from}&to=2026-12-30T00:00:00.000Z`,
    );
    expect(tooLong.statusCode).toBe(400);
  });

  it('maps upstream failures to 502', async () => {
    const device = await registerDevice(h);
    await assign(h, device.deviceId, ROOM_A1);
    h.deps.schedule.getRecordingPlan = (): Promise<never> =>
      Promise.reject(new Error('connection refused'));
    const res = await signedInject(
      h,
      device,
      'GET',
      `/v1/devices/${device.deviceId}/recording-plan`,
    );
    expect(res.statusCode).toBe(502);
    expect(code(res.body)).toBe('upstream_unavailable');
  });
});
