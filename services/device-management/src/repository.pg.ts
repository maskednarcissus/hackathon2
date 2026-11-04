/**
 * PostgreSQL implementation of `DeviceRepository` (integration stage §1).
 * Tables: capture_devices, device_provisioning_tokens, device_assignments, device_heartbeats,
 * device_commands (V001–V004 + data/migrations/pending/device-management.sql).
 */
import pg from 'pg';
import type {
  CommandStatus,
  Device,
  DeviceAssignment,
  DeviceCommand,
  Heartbeat,
  ProvisioningToken,
} from './domain.js';
import type { FirmwareRelease, FirmwareUpdateReport } from './firmware.js';
import { RepositoryConflictError, type DeviceRepository } from './repository.js';

type Row = Record<string, unknown>;
type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Actor columns are UUIDs; the domain uses `'system'` for "no human actor". */
const actorToDb = (v: string | undefined): string | null => (v && UUID_RE.test(v) ? v : null);
const actorFromDb = (v: unknown): string => (typeof v === 'string' ? v : 'system');

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const isoOpt = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : iso(v);
const numOpt = (v: unknown): number | undefined =>
  v === null || v === undefined ? undefined : Number(v);
const strOpt = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : String(v);

/** Drops undefined values (exactOptionalPropertyTypes-friendly object building). */
function defined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function toDevice(r: Row): Device {
  return defined({
    id: String(r['id']),
    serialNumber: String(r['serial_number']),
    model: String(r['model']),
    firmwareVersion: String(r['firmware_version']),
    institutionId: String(r['institution_id']),
    classroomId: strOpt(r['classroom_id']),
    publicKeyPem: String(r['public_key_pem']),
    publicKeyFingerprint: String(r['public_key_fingerprint']),
    certificate: String(r['certificate']),
    certificateIssuedAt: iso(r['certificate_issued_at']),
    certificateExpiresAt: iso(r['certificate_expires_at']),
    credentialStatus: r['credential_status'] as Device['credentialStatus'],
    revokedAt: isoOpt(r['revoked_at']),
    revocationReason: strOpt(r['revocation_reason']),
    maintenanceMode: Boolean(r['maintenance_mode']),
    status: r['status'] as Device['status'],
    lastSeenAt: isoOpt(r['last_seen_at']),
    attestation: (r['attestation'] ?? undefined) as Device['attestation'],
    reportedCapabilities: (r['reported_capabilities'] ??
      undefined) as Device['reportedCapabilities'],
    createdAt: iso(r['created_at']),
    updatedAt: iso(r['updated_at']),
  }) as Device;
}

function toToken(r: Row): ProvisioningToken {
  return defined({
    id: String(r['id']),
    tokenHash: String(r['token_hash']),
    serialNumber: String(r['serial_number']),
    institutionId: String(r['institution_id']),
    expiresAt: iso(r['expires_at']),
    createdBy: actorFromDb(r['created_by']),
    createdAt: iso(r['created_at']),
    usedAt: isoOpt(r['used_at']),
    deviceId: strOpt(r['device_id']),
  }) as ProvisioningToken;
}

function toAssignment(r: Row): DeviceAssignment {
  return defined({
    id: String(r['id']),
    deviceId: String(r['device_id']),
    classroomId: String(r['classroom_id']),
    institutionId: String(r['institution_id']),
    assignedAt: iso(r['assigned_at']),
    assignedBy: actorFromDb(r['assigned_by']),
    unassignedAt: isoOpt(r['unassigned_at']),
    unassignedBy: r['unassigned_at'] ? actorFromDb(r['unassigned_by']) : undefined,
  }) as DeviceAssignment;
}

function toHeartbeat(r: Row): Heartbeat {
  return defined({
    id: String(r['id']),
    deviceId: String(r['device_id']),
    receivedAt: iso(r['received_at']),
    deviceTimestamp: r['device_timestamp'] ? iso(r['device_timestamp']) : '',
    firmwareVersion: String(r['firmware_version'] ?? ''),
    uptimeSeconds: numOpt(r['uptime_seconds']),
    cpuTempC: numOpt(r['cpu_temp_c']),
    diskFreeBytes: Number(r['disk_free_bytes'] ?? 0),
    diskTotalBytes: Number(r['disk_total_bytes'] ?? 0),
    bufferQueueCount: Number(r['buffer_queue_count'] ?? 0),
    bufferQueueBytes: Number(r['buffer_queue_bytes'] ?? 0),
    networkRssiDbm: numOpt(r['network_rssi_dbm']),
    micLevelDbfs: numOpt(r['mic_level_dbfs']),
    isRecording: Boolean(r['is_recording']),
    currentScheduledClassId: strOpt(r['current_scheduled_class_id']),
    lastUploadAt: isoOpt(r['last_upload_at']),
    evictedRecordings: numOpt(r['evicted_recordings']),
    clockSkewMs: numOpt(r['clock_skew_ms']),
    lastError: strOpt(r['last_error']),
  }) as Heartbeat;
}

function toCommand(r: Row): DeviceCommand {
  return defined({
    id: String(r['id']),
    deviceId: String(r['device_id']),
    institutionId: String(r['institution_id']),
    type: r['type'] as DeviceCommand['type'],
    status: r['status'] as DeviceCommand['status'],
    requestedBy: actorFromDb(r['requested_by']),
    issuedAt: iso(r['issued_at']),
    expiresAt: iso(r['expires_at']),
    deliveredAt: isoOpt(r['delivered_at']),
    deliveryCount: Number(r['delivery_count']),
    finishedAt: isoOpt(r['finished_at']),
    resultReceivedAt: isoOpt(r['result_received_at']),
    output: r['output'] === null ? undefined : r['output'],
    cancelledAt: isoOpt(r['cancelled_at']),
    cancelledBy: strOpt(r['cancelled_by']),
  }) as DeviceCommand;
}

function toRelease(r: Row): FirmwareRelease {
  return {
    id: String(r['id']),
    model: String(r['model']),
    version: String(r['version']),
    manifest: String(r['manifest']),
    manifestPayload: r['manifest_payload'] as FirmwareRelease['manifestPayload'],
    rolloutPercent: Number(r['rollout_percent']),
    halted: Boolean(r['halted']),
    createdBy: (r['created_by'] as string | null) ?? null,
    createdAt: iso(r['created_at']),
    updatedAt: iso(r['updated_at']),
  };
}

const isUniqueViolation = (err: unknown): err is pg.DatabaseError =>
  err instanceof pg.DatabaseError && err.code === '23505';

/** Postgres ISO-ish value for a device-provided timestamp; invalid → NULL. */
const tsOrNull = (v: string | undefined): string | null =>
  v && !Number.isNaN(Date.parse(v)) ? v : null;

export class PgDeviceRepository implements DeviceRepository {
  constructor(private readonly pool: pg.Pool) {}

  private async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------ devices
  private async upsertDevice(db: Queryable, d: Device): Promise<void> {
    await db.query(
      `INSERT INTO capture_devices (
         id, classroom_id, serial_number, model, firmware_version, status, last_seen_at,
         institution_id, public_key_pem, public_key_fingerprint, certificate,
         certificate_issued_at, certificate_expires_at, credential_status, revoked_at,
         revocation_reason, maintenance_mode, created_at, updated_at, attestation,
         reported_capabilities)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         classroom_id = EXCLUDED.classroom_id, serial_number = EXCLUDED.serial_number,
         model = EXCLUDED.model, firmware_version = EXCLUDED.firmware_version,
         status = EXCLUDED.status, last_seen_at = EXCLUDED.last_seen_at,
         institution_id = EXCLUDED.institution_id, public_key_pem = EXCLUDED.public_key_pem,
         public_key_fingerprint = EXCLUDED.public_key_fingerprint,
         certificate = EXCLUDED.certificate, certificate_issued_at = EXCLUDED.certificate_issued_at,
         certificate_expires_at = EXCLUDED.certificate_expires_at,
         credential_status = EXCLUDED.credential_status, revoked_at = EXCLUDED.revoked_at,
         revocation_reason = EXCLUDED.revocation_reason,
         maintenance_mode = EXCLUDED.maintenance_mode, updated_at = EXCLUDED.updated_at,
         attestation = EXCLUDED.attestation, reported_capabilities = EXCLUDED.reported_capabilities`,
      [
        d.id,
        d.classroomId ?? null,
        d.serialNumber,
        d.model,
        d.firmwareVersion,
        d.status,
        d.lastSeenAt ?? null,
        d.institutionId,
        d.publicKeyPem,
        d.publicKeyFingerprint,
        d.certificate,
        d.certificateIssuedAt,
        d.certificateExpiresAt,
        d.credentialStatus,
        d.revokedAt ?? null,
        d.revocationReason ?? null,
        d.maintenanceMode,
        d.createdAt,
        d.updatedAt,
        d.attestation ? JSON.stringify(d.attestation) : null,
        d.reportedCapabilities ? JSON.stringify(d.reportedCapabilities) : null,
      ],
    );
  }

  async saveDevice(device: Device): Promise<void> {
    await this.upsertDevice(this.pool, device);
  }

  async getDevice(id: string): Promise<Device | undefined> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM capture_devices WHERE id = $1', [
      id,
    ]);
    return rows[0] ? toDevice(rows[0]) : undefined;
  }

  async findDeviceBySerial(serialNumber: string): Promise<Device | undefined> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM capture_devices WHERE serial_number = $1',
      [serialNumber],
    );
    return rows[0] ? toDevice(rows[0]) : undefined;
  }

  async listDevices(
    filter: { institutionId?: string; classroomId?: string } = {},
  ): Promise<Device[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM capture_devices
        WHERE ($1::uuid IS NULL OR institution_id = $1) AND ($2::uuid IS NULL OR classroom_id = $2)
        ORDER BY serial_number`,
      [filter.institutionId ?? null, filter.classroomId ?? null],
    );
    return rows.map(toDevice);
  }

  // ------------------------------------------------------------------ tokens
  async saveToken(t: ProvisioningToken): Promise<void> {
    await this.pool.query(
      `INSERT INTO device_provisioning_tokens
         (id, token_hash, serial_number, institution_id, expires_at, created_by, used_at, device_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET used_at = EXCLUDED.used_at, device_id = EXCLUDED.device_id`,
      [
        t.id,
        t.tokenHash,
        t.serialNumber,
        t.institutionId,
        t.expiresAt,
        actorToDb(t.createdBy),
        t.usedAt ?? null,
        t.deviceId ?? null,
        t.createdAt,
      ],
    );
  }

  async findTokenByHash(tokenHash: string): Promise<ProvisioningToken | undefined> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM device_provisioning_tokens WHERE token_hash = $1',
      [tokenHash],
    );
    return rows[0] ? toToken(rows[0]) : undefined;
  }

  async registerDevice(tokenId: string, usedAt: string, device: Device): Promise<boolean> {
    return this.tx(async (client) => {
      // Single-statement consume: concurrent registrations with one token cannot both win.
      const consumed = await client.query(
        `UPDATE device_provisioning_tokens SET used_at = $2
          WHERE id = $1 AND used_at IS NULL RETURNING id`,
        [tokenId, usedAt],
      );
      if (consumed.rowCount === 0) return false;
      await this.upsertDevice(client, device);
      await client.query('UPDATE device_provisioning_tokens SET device_id = $2 WHERE id = $1', [
        tokenId,
        device.id,
      ]);
      return true;
    });
  }

  // ------------------------------------------------------------------ assignments
  private async upsertAssignment(db: Queryable, a: DeviceAssignment): Promise<void> {
    await db.query(
      `INSERT INTO device_assignments
         (id, device_id, classroom_id, institution_id, assigned_at, assigned_by, unassigned_at, unassigned_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET unassigned_at = EXCLUDED.unassigned_at,
         unassigned_by = EXCLUDED.unassigned_by`,
      [
        a.id,
        a.deviceId,
        a.classroomId,
        a.institutionId,
        a.assignedAt,
        actorToDb(a.assignedBy),
        a.unassignedAt ?? null,
        actorToDb(a.unassignedBy),
      ],
    );
  }

  async saveAssignment(assignment: DeviceAssignment): Promise<void> {
    await this.upsertAssignment(this.pool, assignment);
  }

  async applyAssignment(change: {
    device: Device;
    close?: DeviceAssignment;
    open?: DeviceAssignment;
  }): Promise<void> {
    try {
      await this.tx(async (client) => {
        // Serialise changes for this device (row lock) — partial unique indexes guard the rest.
        await client.query('SELECT id FROM capture_devices WHERE id = $1 FOR UPDATE', [
          change.device.id,
        ]);
        if (change.close) await this.upsertAssignment(client, change.close);
        if (change.open) await this.upsertAssignment(client, change.open);
        await this.upsertDevice(client, change.device);
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new RepositoryConflictError(err.constraint ?? 'unique', err.message);
      }
      throw err;
    }
  }

  async getActiveAssignment(deviceId: string): Promise<DeviceAssignment | undefined> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM device_assignments WHERE device_id = $1 AND unassigned_at IS NULL',
      [deviceId],
    );
    return rows[0] ? toAssignment(rows[0]) : undefined;
  }

  async listAssignments(deviceId: string): Promise<DeviceAssignment[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM device_assignments WHERE device_id = $1
        ORDER BY assigned_at DESC, (unassigned_at IS NULL) DESC, unassigned_at DESC`,
      [deviceId],
    );
    return rows.map(toAssignment);
  }

  // ------------------------------------------------------------------ heartbeats
  async addHeartbeat(h: Heartbeat, retainPerDevice: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO device_heartbeats (
         id, device_id, received_at, device_timestamp, firmware_version, uptime_seconds,
         cpu_temp_c, disk_free_bytes, disk_total_bytes, buffer_queue_count, buffer_queue_bytes,
         network_rssi_dbm, mic_level_dbfs, is_recording, current_scheduled_class_id,
         last_upload_at, evicted_recordings, clock_skew_ms, last_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        h.id,
        h.deviceId,
        h.receivedAt,
        tsOrNull(h.deviceTimestamp),
        h.firmwareVersion,
        h.uptimeSeconds ?? null,
        h.cpuTempC ?? null,
        h.diskFreeBytes,
        h.diskTotalBytes,
        h.bufferQueueCount,
        h.bufferQueueBytes,
        h.networkRssiDbm ?? null,
        h.micLevelDbfs ?? null,
        h.isRecording,
        h.currentScheduledClassId ?? null,
        h.lastUploadAt ?? null,
        h.evictedRecordings ?? null,
        h.clockSkewMs ?? null,
        h.lastError ?? null,
      ],
    );
    // Keep the newest `retainPerDevice` rows (index-backed: device_id, received_at DESC).
    await this.pool.query(
      `DELETE FROM device_heartbeats
        WHERE device_id = $1 AND received_at < (
          SELECT received_at FROM device_heartbeats WHERE device_id = $1
           ORDER BY received_at DESC OFFSET $2 LIMIT 1)`,
      [h.deviceId, retainPerDevice - 1],
    );
  }

  async latestHeartbeat(deviceId: string): Promise<Heartbeat | undefined> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM device_heartbeats WHERE device_id = $1 ORDER BY received_at DESC LIMIT 1',
      [deviceId],
    );
    return rows[0] ? toHeartbeat(rows[0]) : undefined;
  }

  async listHeartbeats(deviceId: string, limit: number): Promise<Heartbeat[]> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM device_heartbeats WHERE device_id = $1 ORDER BY received_at DESC LIMIT $2',
      [deviceId, limit],
    );
    return rows.map(toHeartbeat);
  }

  async listHeartbeatsSince(deviceId: string, since: string): Promise<Heartbeat[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM device_heartbeats WHERE device_id = $1 AND received_at >= $2
        ORDER BY received_at ASC`,
      [deviceId, since],
    );
    return rows.map(toHeartbeat);
  }

  // ------------------------------------------------------------------ commands
  private commandParams(c: DeviceCommand): unknown[] {
    return [
      c.id,
      c.deviceId,
      c.institutionId,
      c.type,
      c.status,
      actorToDb(c.requestedBy),
      c.issuedAt,
      c.expiresAt,
      c.deliveredAt ?? null,
      c.deliveryCount,
      c.finishedAt ?? null,
      c.resultReceivedAt ?? null,
      c.output === undefined ? null : JSON.stringify(c.output),
      c.cancelledAt ?? null,
      actorToDb(c.cancelledBy),
    ];
  }

  private static readonly COMMAND_INSERT = `INSERT INTO device_commands (
      id, device_id, institution_id, type, status, requested_by, issued_at, expires_at,
      delivered_at, delivery_count, finished_at, result_received_at, output, cancelled_at, cancelled_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)`;

  async saveCommand(c: DeviceCommand): Promise<void> {
    await this.pool.query(
      `${PgDeviceRepository.COMMAND_INSERT}
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status,
         delivered_at = EXCLUDED.delivered_at, delivery_count = EXCLUDED.delivery_count,
         finished_at = EXCLUDED.finished_at, result_received_at = EXCLUDED.result_received_at,
         output = EXCLUDED.output, cancelled_at = EXCLUDED.cancelled_at,
         cancelled_by = EXCLUDED.cancelled_by`,
      this.commandParams(c),
    );
  }

  async createCommand(
    c: DeviceCommand,
    attempt = 0,
  ): Promise<{ command: DeviceCommand; created: boolean }> {
    // uq_device_commands_open_type makes the insert the dedup decision (no read-then-write race).
    const inserted = await this.pool.query<Row>(
      `${PgDeviceRepository.COMMAND_INSERT}
       ON CONFLICT (device_id, type) WHERE status IN ('pending', 'delivered') DO NOTHING
       RETURNING *`,
      this.commandParams(c),
    );
    if (inserted.rows[0]) return { command: toCommand(inserted.rows[0]), created: true };
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM device_commands
        WHERE device_id = $1 AND type = $2 AND status IN ('pending', 'delivered')`,
      [c.deviceId, c.type],
    );
    // The open one finished in between: retry the insert (bounded).
    if (!rows[0] && attempt < 3) return this.createCommand(c, attempt + 1);
    if (!rows[0]) throw new RepositoryConflictError('uq_device_commands_open_type', 'retry later');
    return { command: toCommand(rows[0]), created: false };
  }

  // ------------------------------------------------------------------ firmware (Phase 6)
  async saveRelease(r: FirmwareRelease): Promise<void> {
    await this.pool.query(
      `INSERT INTO firmware_releases (id, model, version, manifest, manifest_payload, key_id,
         rollout_percent, halted, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET rollout_percent = EXCLUDED.rollout_percent,
         halted = EXCLUDED.halted, updated_at = EXCLUDED.updated_at`,
      [
        r.id,
        r.model,
        r.version,
        r.manifest,
        JSON.stringify(r.manifestPayload),
        r.manifestPayload.keyId,
        r.rolloutPercent,
        r.halted,
        actorToDb(r.createdBy ?? undefined),
        r.createdAt,
        r.updatedAt,
      ],
    );
  }

  async getRelease(id: string): Promise<FirmwareRelease | undefined> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM firmware_releases WHERE id = $1', [
      id,
    ]);
    return rows[0] ? toRelease(rows[0]) : undefined;
  }

  async findRelease(model: string, version: string): Promise<FirmwareRelease | undefined> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM firmware_releases WHERE model = $1 AND version = $2',
      [model, version],
    );
    return rows[0] ? toRelease(rows[0]) : undefined;
  }

  async listReleases(model?: string): Promise<FirmwareRelease[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM firmware_releases WHERE ($1::text IS NULL OR model = $1)
        ORDER BY created_at DESC`,
      [model ?? null],
    );
    return rows.map(toRelease);
  }

  async saveUpdateReport(r: FirmwareUpdateReport): Promise<void> {
    await this.pool.query(
      `INSERT INTO device_firmware_update_reports (id, device_id, release_id, state, error, reported_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (device_id, release_id) DO UPDATE SET state = EXCLUDED.state,
         error = EXCLUDED.error, reported_at = EXCLUDED.reported_at`,
      [r.id, r.deviceId, r.releaseId, r.state, r.error ?? null, r.reportedAt],
    );
  }

  async listUpdateReports(filter: {
    releaseId?: string;
    deviceId?: string;
  }): Promise<FirmwareUpdateReport[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM device_firmware_update_reports
        WHERE ($1::uuid IS NULL OR release_id = $1) AND ($2::uuid IS NULL OR device_id = $2)
        ORDER BY reported_at DESC`,
      [filter.releaseId ?? null, filter.deviceId ?? null],
    );
    return rows.map(
      (r) =>
        defined({
          id: String(r['id']),
          deviceId: String(r['device_id']),
          releaseId: String(r['release_id']),
          state: r['state'] as FirmwareUpdateReport['state'],
          error: strOpt(r['error']),
          reportedAt: iso(r['reported_at']),
        }) as FirmwareUpdateReport,
    );
  }

  async getCommand(id: string): Promise<DeviceCommand | undefined> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM device_commands WHERE id = $1', [
      id,
    ]);
    return rows[0] ? toCommand(rows[0]) : undefined;
  }

  async listCommands(
    filter: { deviceId?: string; statuses?: readonly CommandStatus[] },
    limit?: number,
  ): Promise<DeviceCommand[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM device_commands
        WHERE ($1::uuid IS NULL OR device_id = $1)
          AND ($2::device_command_status[] IS NULL OR status = ANY($2))
        ORDER BY issued_at DESC, seq DESC
        LIMIT $3`,
      [filter.deviceId ?? null, filter.statuses ? [...filter.statuses] : null, limit ?? null],
    );
    return rows.map(toCommand);
  }
}

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max });
}
