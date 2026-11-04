/**
 * Postgres behavioural suite (integration stage §1). Runs only with TEST_DATABASE_URL, e.g.
 *   TEST_DATABASE_URL='postgresql://ci@/postgres?host=/var/tmp/cipg&port=5433' pnpm test
 */
import { generateKeyPairSync } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { signManifest } from './firmware.js';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDeviceRepository } from './repository.pg.js';
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from './test/pgdb.js';
import {
  ADMIN_ID,
  CAMPUS_1,
  CAMPUS_2,
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

const HOLDING = '00000000-0000-4000-8000-0000000000aa';

async function seedOrganization(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO holding_companies (id, name, legal_name) VALUES ($1, 'Grupo', 'Grupo S.A.')`,
    [HOLDING],
  );
  await pool.query(
    `INSERT INTO institutions (id, holding_company_id, name, state) VALUES ($1,$3,'A','SP'), ($2,$3,'B','PE')`,
    [INSTITUTION_A, INSTITUTION_B, HOLDING],
  );
  await pool.query(
    `INSERT INTO campuses (id, institution_id, name, city, state) VALUES
       ($1,$2,'Campus Paulista','São Paulo','SP'), ($3,$4,'Campus Recife','Recife','PE')`,
    [CAMPUS_1, INSTITUTION_A, CAMPUS_2, INSTITUTION_B],
  );
  await pool.query(
    `INSERT INTO classrooms (id, campus_id, name, code) VALUES
       ($1,$4,'Sala 101','A-101'), ($2,$4,'Laboratório 2','LAB-2'), ($3,$5,'Auditório','AUD')`,
    [ROOM_A1, ROOM_A2, ROOM_B1, CAMPUS_1, CAMPUS_2],
  );
}

const code = (body: string): string => (JSON.parse(body) as { error: { code: string } }).error.code;

describe.skipIf(!TEST_DATABASE_URL)('PgDeviceRepository (Postgres)', () => {
  let db: TestDatabase;
  let h: Harness;

  beforeAll(async () => {
    db = await createTestDatabase(TEST_DATABASE_URL ?? '', [
      'device-management.sql',
      'device-management-phase6.sql',
    ]);
    await seedOrganization(db.pool);
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await db.pool.query(
      'TRUNCATE device_firmware_update_reports, firmware_releases, device_commands, device_heartbeats, device_assignments, device_provisioning_tokens, capture_devices CASCADE',
    );
    h = createHarness({ repo: new PgDeviceRepository(db.pool) });
  });

  it('registers once per token, even under concurrent attempts', async () => {
    const token = await createToken(h, 'CI-PG-0001');
    const attempt = (): Promise<LightMyRequestResponse> =>
      h.app.inject({
        method: 'POST',
        url: '/v1/devices/register',
        payload: {
          provisioningToken: token,
          serialNumber: 'CI-PG-0001',
          model: 'ci-capture-a1',
          firmwareVersion: '1.0.0',
          publicKeyPem: newKeyPair().publicKeyPem,
        },
      });
    const results = await Promise.all([attempt(), attempt(), attempt()]);
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses[0]).toBe(201);
    // Losers see either the consumed token or the already-registered serial — never a 500.
    expect(statuses.slice(1).every((s) => s === 401 || s === 409)).toBe(true);
    const { rows } = await db.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM capture_devices',
    );
    expect(rows[0]?.n).toBe('1');
    const tok = await db.pool.query<{ device_id: string | null; used_at: Date | null }>(
      'SELECT device_id, used_at FROM device_provisioning_tokens',
    );
    expect(tok.rows[0]?.device_id).toBeTruthy();
    expect(tok.rows[0]?.used_at).toBeInstanceOf(Date);
  });

  it('round-trips devices, certificates and revocation', async () => {
    const d = await registerDevice(h, 'CI-PG-0002');
    const device = await h.repo.getDevice(d.deviceId);
    expect(device).toMatchObject({
      serialNumber: 'CI-PG-0002',
      institutionId: INSTITUTION_A,
      credentialStatus: 'active',
      certificate: d.certificate,
      createdAt: '2026-11-04T12:00:00.000Z',
    });
    await h.app.inject({
      method: 'POST',
      url: `/v1/devices/${d.deviceId}/revoke`,
      headers: adminHeaders,
      payload: { reason: 'stolen device' },
    });
    const res = await signedInject(
      h,
      d,
      'POST',
      `/v1/devices/${d.deviceId}/heartbeat`,
      healthyMetrics,
    );
    expect(code(res.body)).toBe('device_revoked');
    // Re-provisioning keeps the device id.
    expect((await registerDevice(h, 'CI-PG-0002')).deviceId).toBe(d.deviceId);
  });

  it('keeps assignment history and enforces one active device per classroom', async () => {
    const a = await registerDevice(h, 'CI-PG-0003');
    const b = await registerDevice(h, 'CI-PG-0004');
    expect((await assign(h, a.deviceId, ROOM_A1)).statusCode).toBe(200);
    expect((await assign(h, a.deviceId, ROOM_A2)).statusCode).toBe(200);
    const history = await h.repo.listAssignments(a.deviceId);
    expect(history.map((x) => [x.classroomId, Boolean(x.unassignedAt)])).toEqual([
      [ROOM_A2, false],
      [ROOM_A1, true],
    ]);
    expect(history[0]?.assignedBy).toBe(ADMIN_ID);

    const occupied = await assign(h, b.deviceId, ROOM_A2);
    expect(code(occupied.body)).toBe('classroom_occupied');

    // Two devices racing for the same free classroom: exactly one wins.
    const c = await registerDevice(h, 'CI-PG-0005');
    const race = await Promise.all([
      assign(h, b.deviceId, ROOM_A1),
      assign(h, c.deviceId, ROOM_A1),
    ]);
    expect(race.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const { rows } = await db.pool.query(
      `SELECT id FROM capture_devices WHERE classroom_id = $1 AND credential_status = 'active'`,
      [ROOM_A1],
    );
    expect(rows).toHaveLength(1);

    expect(
      (
        await h.app.inject({
          method: 'DELETE',
          url: `/v1/devices/${a.deviceId}/assignment`,
          headers: adminHeaders,
        })
      ).statusCode,
    ).toBe(204);
    expect(await h.repo.getActiveAssignment(a.deviceId)).toBeUndefined();
  });

  it('stores heartbeats (incl. Phase 1 follow-up fields), derives status and sweeps offline', async () => {
    const d = await registerDevice(h, 'CI-PG-0006');
    await assign(h, d.deviceId, ROOM_A1);
    const res = await signedInject(h, d, 'POST', `/v1/devices/${d.deviceId}/heartbeat`, {
      ...healthyMetrics,
      evictedRecordings: 2,
      clockSkewMs: 12_000,
      lastError: 'upload failed: 503',
      currentScheduledClassId: '99999999-9999-4999-8999-999999999999',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'attention_required',
      issues: ['clock_skew', 'recordings_evicted'],
    });
    const latest = await h.repo.latestHeartbeat(d.deviceId);
    expect(latest).toMatchObject({
      evictedRecordings: 2,
      clockSkewMs: 12_000,
      lastError: 'upload failed: 503',
      cpuTempC: 52.5,
      diskFreeBytes: healthyMetrics.diskFreeBytes,
    });

    h.clock.advance(200_000);
    const sweep = await h.sweepStatuses();
    expect(sweep.transitions).toEqual([
      { deviceId: d.deviceId, from: 'attention_required', to: 'offline' },
    ]);
    expect(h.events.events.map((e) => e.type)).toContain('device.heartbeat_missed');

    const fleet = await h.app.inject({
      method: 'GET',
      url: '/v1/fleet/health',
      headers: adminHeaders,
    });
    expect(fleet.json()).toMatchObject({ summary: { total: 1, byStatus: { offline: 1 } } });
  });

  it('retains the newest heartbeats only and serves diagnostics windows', async () => {
    const small = createHarness({ repo: new PgDeviceRepository(db.pool) });
    const d = await registerDevice(small, 'CI-PG-0007');
    for (let i = 0; i < 5; i += 1) {
      await signedInject(small, d, 'POST', `/v1/devices/${d.deviceId}/heartbeat`, {
        ...healthyMetrics,
        uptimeSeconds: i,
      });
      small.clock.advance(60_000);
    }
    const all = await small.repo.listHeartbeats(d.deviceId, 100);
    expect(all.map((x) => x.uptimeSeconds)).toEqual([4, 3, 2, 1, 0]);
    await small.repo.addHeartbeat(
      { ...all[0]!, id: crypto.randomUUID(), receivedAt: small.clock.now().toISOString() },
      3,
    );
    expect(await small.repo.listHeartbeats(d.deviceId, 100)).toHaveLength(3);

    const diag = await small.app.inject({
      method: 'GET',
      url: `/v1/devices/${d.deviceId}/diagnostics?windowHours=1`,
      headers: adminHeaders,
    });
    expect(diag.statusCode).toBe(200);
    expect(diag.json<{ uptime: { receivedHeartbeats: number } }>().uptime.receivedHeartbeats).toBe(
      3,
    );
  });

  it('deduplicates concurrent commands and runs the full command lifecycle', async () => {
    const d = await registerDevice(h, 'CI-PG-0008');
    const issue = (): Promise<LightMyRequestResponse> =>
      h.app.inject({
        method: 'POST',
        url: `/v1/devices/${d.deviceId}/commands`,
        headers: adminHeaders,
        payload: { type: 'self_test', requestedBy: ADMIN_ID },
      });
    const [x, y] = await Promise.all([issue(), issue()]);
    const ids = new Set([x, y].map((r) => r.json<{ commandId: string }>().commandId));
    expect(ids.size).toBe(1);
    const [commandId] = [...ids] as [string];

    const hb = await signedInject(
      h,
      d,
      'POST',
      `/v1/devices/${d.deviceId}/heartbeat`,
      healthyMetrics,
    );
    expect(
      hb.json<{ commands: { commandId: string }[] }>().commands.map((c) => c.commandId),
    ).toEqual([commandId]);
    const output = { checks: { disk: { ok: true } } };
    const result = await signedInject(
      h,
      d,
      'POST',
      `/v1/devices/${d.deviceId}/commands/${commandId}/result`,
      { status: 'succeeded', output, finishedAt: h.clock.now().toISOString() },
    );
    expect(result.json()).toMatchObject({ status: 'succeeded', output, deliveryCount: 1 });
    expect(await h.repo.getCommand(commandId)).toMatchObject({ status: 'succeeded', output });

    // A new command of the same type is allowed once the previous one finished.
    const again = await issue();
    expect(again.json<{ commandId: string }>().commandId).not.toBe(commandId);

    // Expiry via the sweep.
    h.clock.advance(31 * 60_000);
    expect((await h.sweepStatuses()).expiredCommands).toBe(1);
    const history = await h.app.inject({
      method: 'GET',
      url: `/v1/devices/${d.deviceId}/commands`,
      headers: adminHeaders,
    });
    expect(history.json<{ items: { status: string }[] }>().items.map((c) => c.status)).toEqual([
      'expired',
      'succeeded',
    ]);
  });

  it('serves the fleet console and firmware distribution from Postgres', async () => {
    const a = await registerDevice(h, 'CI-PG-0009');
    await registerDevice(h, 'CI-PG-0010', INSTITUTION_B);
    await assign(h, a.deviceId, ROOM_A1);
    await signedInject(h, a, 'POST', `/v1/devices/${a.deviceId}/heartbeat`, {
      ...healthyMetrics,
      firmwareVersion: '1.10.0',
    });
    const fleet = await h.app.inject({
      method: 'GET',
      url: `/v1/fleet?institutionId=${INSTITUTION_A}`,
      headers: adminHeaders,
    });
    expect(fleet.json()).toMatchObject({
      total: 1,
      items: [{ serialNumber: 'CI-PG-0009', classroom: { name: 'Sala 101' } }],
    });
    const fw = await h.app.inject({
      method: 'GET',
      url: '/v1/fleet/firmware',
      headers: adminHeaders,
    });
    expect(fw.json()).toMatchObject({ total: 2, latestVersion: '1.10.0', outdated: 1 });
  });

  it('maps foreign-key violations to 422 (unknown institution)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/provisioning-tokens',
      headers: adminHeaders,
      payload: {
        serialNumber: 'CI-PG-0011',
        institutionId: '33333333-3333-4333-8333-333333333333',
      },
    });
    expect(res.statusCode).toBe(422);
    expect(code(res.body)).toBe('invalid_reference');
  });

  it('stores firmware releases, rollout changes and update reports', async () => {
    const d = await registerDevice(h, 'CI-PG-0012');
    const key = generateKeyPairSync('ed25519');
    const signer = createHarness({ repo: new PgDeviceRepository(db.pool) });
    // Re-build with a release key trusted (uses the same database).
    const { buildApp } = await import('./app.js');
    const built = buildApp({
      adminToken: 'test-admin-token',
      firmwareTrustedKeys: new Map([['k1', key.publicKey]]),
      deps: { ...signer.deps, repo: new PgDeviceRepository(db.pool) },
    });
    const manifest = signManifest(
      {
        v: 1,
        model: 'ci-capture-a1',
        version: '1.1.0',
        url: 'https://firmware.example/a1-1.1.0.img',
        sha256: 'c'.repeat(64),
        sizeBytes: 1000,
        releasedAt: '2026-11-01T00:00:00.000Z',
        keyId: 'k1',
      },
      key.privateKey,
    );
    const created = await built.app.inject({
      method: 'POST',
      url: '/v1/firmware/releases',
      headers: adminHeaders,
      payload: { manifest },
    });
    expect(created.statusCode).toBe(201);
    const releaseId = created.json<{ releaseId: string }>().releaseId;
    const dup = await built.app.inject({
      method: 'POST',
      url: '/v1/firmware/releases',
      headers: adminHeaders,
      payload: { manifest },
    });
    expect(dup.statusCode).toBe(409);
    await built.app.inject({
      method: 'PUT',
      url: `/v1/firmware/releases/${releaseId}/rollout`,
      headers: adminHeaders,
      payload: { percent: 100 },
    });
    const offer = await signedInject(
      { ...signer, app: built.app },
      d,
      'GET',
      `/v1/devices/${d.deviceId}/firmware-update`,
    );
    expect(offer.json()).toMatchObject({ updateAvailable: true, version: '1.1.0', manifest });
    for (const state of ['downloading', 'staged'] as const) {
      await signedInject(
        { ...signer, app: built.app },
        d,
        'POST',
        `/v1/devices/${d.deviceId}/firmware-update/status`,
        {
          releaseId,
          state,
        },
      );
    }
    const reports = await new PgDeviceRepository(db.pool).listUpdateReports({ releaseId });
    expect(reports.map((r) => r.state)).toEqual(['staged']);
    const release = await new PgDeviceRepository(db.pool).getRelease(releaseId);
    expect(release).toMatchObject({ rolloutPercent: 100, halted: false, manifest });
  });
});
