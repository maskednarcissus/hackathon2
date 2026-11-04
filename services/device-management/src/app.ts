import { randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import {
  InMemoryAuditClient,
  InMemoryEventPublisher,
  UpstreamError,
  type AuditClient,
  type AuditEventInput,
  type EventPublisher,
  type OrganizationClient,
  type ScheduleClient,
} from './clients.js';
import {
  issueCertificate,
  loadDeviceCa,
  normalizePublicKeyPem,
  parseEd25519PublicKey,
  publicKeyFingerprint,
  sha256Hex,
  generateProvisioningToken,
  type DeviceCa,
} from './crypto.js';
import {
  DEVICE_STATUSES,
  type Device,
  type DeviceStatus,
  type Heartbeat,
  type ProvisioningToken,
} from './domain.js';
import {
  AppError,
  conflict,
  forbidden,
  notFound,
  registerErrorHandler,
  unauthorized,
} from './errors.js';
import { deriveHealth } from './health.js';
import { InMemoryDeviceRepository, type DeviceRepository } from './repository.js';
import {
  AssignDevice,
  FleetQuery,
  HealthQuery,
  HeartbeatBody,
  IdParams,
  MaintenanceMode,
  PlanQuery,
  ProvisioningTokenCreate,
  RegisterDevice,
  RevokeDevice,
} from './schemas.js';
import { createDeviceAuthHook } from './signature.js';

export interface Clock {
  now(): Date;
}

export interface DeviceManagementDeps {
  repo: DeviceRepository;
  organization: OrganizationClient;
  schedule: ScheduleClient;
  audit: AuditClient;
  events: EventPublisher;
  clock: Clock;
  ca: DeviceCa;
  idGenerator: () => string;
}

export interface BuildAppOptions {
  deps: Partial<DeviceManagementDeps> & Pick<DeviceManagementDeps, 'organization' | 'schedule'>;
  /** When set, admin routes require `Authorization: Bearer <adminToken>`. */
  adminToken?: string;
  certificateValidityDays?: number;
  heartbeatRetention?: number;
  logger?: FastifyServerOptions['logger'];
  /** Pre-built pino logger (takes precedence over `logger`). */
  loggerInstance?: FastifyBaseLogger;
}

export interface SweepResult {
  checked: number;
  transitions: { deviceId: string; from: DeviceStatus; to: DeviceStatus }[];
}

export interface DeviceManagementApp {
  app: FastifyInstance;
  deps: DeviceManagementDeps;
  /** Re-derives every device status; emits device.heartbeat_missed on online→offline transitions. */
  sweepStatuses(): Promise<SweepResult>;
}

const ACTOR_HEADER = 'x-actor-id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildApp(options: BuildAppOptions): DeviceManagementApp {
  const deps: DeviceManagementDeps = {
    repo: options.deps.repo ?? new InMemoryDeviceRepository(),
    organization: options.deps.organization,
    schedule: options.deps.schedule,
    audit: options.deps.audit ?? new InMemoryAuditClient(),
    events: options.deps.events ?? new InMemoryEventPublisher(),
    clock: options.deps.clock ?? { now: () => new Date() },
    ca: options.deps.ca ?? loadDeviceCa(undefined),
    idGenerator: options.deps.idGenerator ?? randomUUID,
  };
  const { repo, clock } = deps;
  const certificateValidityDays = options.certificateValidityDays ?? 365;
  const heartbeatRetention = options.heartbeatRetention ?? 1440;

  const app: FastifyInstance = options.loggerInstance
    ? (Fastify({
        loggerInstance: options.loggerInstance,
        bodyLimit: 256 * 1024,
      }) as unknown as FastifyInstance)
    : Fastify({ logger: options.logger ?? false, bodyLimit: 256 * 1024 });
  registerErrorHandler(app);

  // Keep the raw body: device signatures cover the exact bytes sent.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      request.rawBody = body;
      if (body.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(body.toString('utf8')) as unknown);
      } catch {
        done(new AppError(400, 'invalid_json', 'Request body is not valid JSON'), undefined);
      }
    },
  );

  const nowIso = (): string => clock.now().toISOString();

  // ------------------------------------------------------------------ auth helpers
  const adminTokenBuf = options.adminToken ? Buffer.from(options.adminToken) : undefined;
  const requireAdmin = (request: FastifyRequest): Promise<void> => {
    if (!adminTokenBuf) return Promise.resolve();
    const header = request.headers.authorization ?? '';
    const provided = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (provided.length !== adminTokenBuf.length || !timingSafeEqual(provided, adminTokenBuf)) {
      return Promise.reject(
        unauthorized('admin_auth_required', 'Valid administrator bearer token required'),
      );
    }
    return Promise.resolve();
  };
  const actorOf = (request: FastifyRequest): string | null => {
    const raw = request.headers[ACTOR_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value && UUID_RE.test(value) ? value : null;
  };

  const deviceAuth = createDeviceAuthHook({
    now: () => clock.now(),
    lookup: async (deviceId) => {
      if (!UUID_RE.test(deviceId)) return undefined;
      const device = await repo.getDevice(deviceId);
      return device
        ? {
            deviceId: device.id,
            publicKeyPem: device.publicKeyPem,
            credentialStatus: device.credentialStatus,
          }
        : undefined;
    },
  });

  const audit = (event: AuditEventInput): Promise<void> =>
    deps.audit.record(event).catch((err: unknown) => app.log.warn({ err }, 'audit client threw'));

  const publish = async (
    type: string,
    institutionId: string | null,
    data: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await deps.events.publish({
        eventId: deps.idGenerator(),
        type,
        version: 1,
        occurredAt: nowIso(),
        source: 'device-management',
        institutionId,
        data,
      });
    } catch (err) {
      app.log.error({ err, type }, 'failed to publish event');
    }
  };

  const requireDevice = async (id: string): Promise<Device> => {
    const device = await repo.getDevice(id);
    if (!device) throw notFound('Device', id);
    return device;
  };

  const deviceView = (d: Device): Omit<Device, 'publicKeyPem' | 'certificate'> => {
    const { publicKeyPem: _pk, certificate: _cert, ...rest } = d;
    return rest;
  };

  const healthRow = async (device: Device): Promise<Record<string, unknown>> => {
    const latest = await repo.latestHeartbeat(device.id);
    const health = deriveHealth(device, latest, clock.now());
    return {
      deviceId: device.id,
      serialNumber: device.serialNumber,
      model: device.model,
      firmwareVersion: device.firmwareVersion,
      institutionId: device.institutionId,
      classroomId: device.classroomId ?? null,
      status: health.status,
      issues: health.issues,
      lastSeenAt: device.lastSeenAt ?? null,
      metrics: latest ? metricsOf(latest) : null,
    };
  };

  app.get('/health', () => ({ status: 'ok', service: 'device-management' }));

  // ------------------------------------------------------------------ 1.1 provisioning
  app.post('/v1/provisioning-tokens', { preHandler: requireAdmin }, async (request, reply) => {
    const body = ProvisioningTokenCreate.parse(request.body);
    const existing = await repo.findDeviceBySerial(body.serialNumber);
    if (existing && existing.credentialStatus === 'active') {
      throw conflict(
        'device_already_registered',
        `Serial ${body.serialNumber} is already registered`,
      );
    }
    const token = generateProvisioningToken();
    const now = clock.now();
    const record: ProvisioningToken = {
      id: deps.idGenerator(),
      tokenHash: sha256Hex(token),
      serialNumber: body.serialNumber,
      institutionId: body.institutionId,
      expiresAt: new Date(now.getTime() + body.expiresInHours * 3_600_000).toISOString(),
      createdBy: actorOf(request) ?? 'system',
      createdAt: now.toISOString(),
    };
    await repo.saveToken(record);
    await audit({
      tenantId: body.institutionId,
      actorId: actorOf(request),
      actorType: 'admin',
      action: 'device.provisioning_token_created',
      resourceType: 'provisioning_token',
      resourceId: record.id,
      metadata: { serialNumber: body.serialNumber, expiresAt: record.expiresAt },
    });
    // The plaintext token is returned exactly once and never stored.
    return reply.status(201).send({
      id: record.id,
      token,
      serialNumber: record.serialNumber,
      institutionId: record.institutionId,
      expiresAt: record.expiresAt,
    });
  });

  app.post('/v1/devices/register', async (request, reply) => {
    const body = RegisterDevice.parse(request.body);
    const token = await repo.findTokenByHash(sha256Hex(body.provisioningToken));
    const now = clock.now();
    if (!token) throw unauthorized('invalid_provisioning_token', 'Provisioning token is not valid');
    if (token.usedAt)
      throw unauthorized('provisioning_token_used', 'Provisioning token was already used');
    if (Date.parse(token.expiresAt) <= now.getTime()) {
      throw unauthorized('provisioning_token_expired', 'Provisioning token has expired');
    }
    if (token.serialNumber !== body.serialNumber) {
      throw forbidden(
        'provisioning_token_serial_mismatch',
        'Provisioning token is bound to a different serial number',
      );
    }

    let publicKey;
    try {
      publicKey = parseEd25519PublicKey(body.publicKeyPem);
    } catch (err) {
      throw new AppError(422, 'invalid_public_key', (err as Error).message);
    }
    const fingerprint = publicKeyFingerprint(publicKey);

    const previous = await repo.findDeviceBySerial(body.serialNumber);
    if (previous && previous.credentialStatus === 'active') {
      throw conflict(
        'device_already_registered',
        `Serial ${body.serialNumber} is already registered`,
      );
    }

    // Re-provisioning a revoked/decommissioned unit keeps its device id and history.
    const deviceId = previous?.id ?? deps.idGenerator();
    if (!(await repo.consumeToken(token.id, now.toISOString(), deviceId))) {
      throw unauthorized('provisioning_token_used', 'Provisioning token was already used');
    }

    const issuedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + certificateValidityDays * 86_400_000).toISOString();
    const certificatePayload = {
      v: 1 as const,
      deviceId,
      serialNumber: body.serialNumber,
      institutionId: token.institutionId,
      publicKeyFingerprint: fingerprint,
      issuedAt,
      expiresAt,
      issuer: 'ci-device-ca' as const,
    };
    const certificate = issueCertificate(certificatePayload, deps.ca);

    const device: Device = {
      id: deviceId,
      serialNumber: body.serialNumber,
      model: body.model,
      firmwareVersion: body.firmwareVersion,
      institutionId: token.institutionId,
      publicKeyPem: normalizePublicKeyPem(publicKey),
      publicKeyFingerprint: fingerprint,
      certificate,
      certificateIssuedAt: issuedAt,
      certificateExpiresAt: expiresAt,
      credentialStatus: 'active',
      maintenanceMode: false,
      status: 'offline',
      createdAt: previous?.createdAt ?? issuedAt,
      updatedAt: issuedAt,
    };
    await repo.saveDevice(device);

    await audit({
      tenantId: token.institutionId,
      actorId: deviceId,
      actorType: 'device',
      action: 'device.registered',
      resourceType: 'capture_device',
      resourceId: deviceId,
      metadata: {
        serialNumber: body.serialNumber,
        model: body.model,
        firmwareVersion: body.firmwareVersion,
        publicKeyFingerprint: fingerprint,
        reprovisioned: Boolean(previous),
      },
    });
    await publish('device.registered', token.institutionId, {
      deviceId,
      serialNumber: body.serialNumber,
    });

    return reply.status(201).send({ deviceId, certificate, certificatePayload });
  });

  app.get('/v1/device-ca/public-key', () => ({
    issuer: 'ci-device-ca',
    publicKeyPem: deps.ca.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  }));

  // ------------------------------------------------------------------ registry (admin)
  app.get('/v1/devices', { preHandler: requireAdmin }, async (request) => {
    const q = FleetQuery.parse(request.query);
    const filter: { institutionId?: string; classroomId?: string } = {};
    if (q.institutionId) filter.institutionId = q.institutionId;
    if (q.classroomId) filter.classroomId = q.classroomId;
    return { items: (await repo.listDevices(filter)).map(deviceView) };
  });

  app.get('/v1/devices/:id', { preHandler: requireAdmin }, async (request) => {
    const device = await requireDevice(IdParams.parse(request.params).id);
    return { ...deviceView(device), certificate: device.certificate };
  });

  // ------------------------------------------------------------------ 1.2 classroom mapping
  app.put('/v1/devices/:id/assignment', { preHandler: requireAdmin }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const { classroomId } = AssignDevice.parse(request.body);
    const device = await requireDevice(id);
    if (device.credentialStatus !== 'active') {
      throw conflict('device_not_active', `Cannot assign a ${device.credentialStatus} device`);
    }
    let classroom;
    try {
      classroom = await deps.organization.getClassroom(classroomId);
    } catch (err) {
      throw upstream(err);
    }
    if (!classroom) throw notFound('Classroom', classroomId);
    if (classroom.institutionId !== device.institutionId) {
      throw conflict(
        'tenant_mismatch',
        'Classroom belongs to a different institution than the device',
      );
    }

    const current = await repo.getActiveAssignment(id);
    if (current?.classroomId === classroomId) return { assignment: current, changed: false };

    // A classroom has at most one active capture device.
    const occupying = (await repo.listDevices({ classroomId })).filter(
      (d) => d.id !== id && d.credentialStatus === 'active',
    );
    if (occupying.length > 0) {
      throw conflict('classroom_occupied', 'Classroom already has an active capture device', {
        deviceIds: occupying.map((d) => d.id),
      });
    }

    const actor = actorOf(request) ?? 'system';
    const ts = nowIso();
    if (current) await repo.saveAssignment({ ...current, unassignedAt: ts, unassignedBy: actor });
    const assignment = {
      id: deps.idGenerator(),
      deviceId: id,
      classroomId,
      institutionId: classroom.institutionId,
      assignedAt: ts,
      assignedBy: actor,
    };
    await repo.saveAssignment(assignment);
    await repo.saveDevice({ ...device, classroomId, updatedAt: ts });

    await audit({
      tenantId: device.institutionId,
      actorId: actorOf(request),
      actorType: 'admin',
      action: 'device.assigned',
      resourceType: 'capture_device',
      resourceId: id,
      metadata: {
        classroomId,
        campusId: classroom.campusId,
        previousClassroomId: current?.classroomId ?? null,
      },
    });
    await publish('device.assigned', device.institutionId, {
      deviceId: id,
      classroomId,
      ...(current ? { previousClassroomId: current.classroomId } : {}),
    });
    return { assignment, changed: true };
  });

  app.delete('/v1/devices/:id/assignment', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const device = await requireDevice(id);
    const current = await repo.getActiveAssignment(id);
    if (!current) throw conflict('device_unassigned', 'Device has no active assignment');
    const ts = nowIso();
    await repo.saveAssignment({
      ...current,
      unassignedAt: ts,
      unassignedBy: actorOf(request) ?? 'system',
    });
    const { classroomId: _c, ...rest } = device;
    await repo.saveDevice({ ...rest, updatedAt: ts });
    await audit({
      tenantId: device.institutionId,
      actorId: actorOf(request),
      actorType: 'admin',
      action: 'device.unassigned',
      resourceType: 'capture_device',
      resourceId: id,
      metadata: { classroomId: current.classroomId },
    });
    return reply.status(204).send();
  });

  app.get('/v1/devices/:id/assignments', { preHandler: requireAdmin }, async (request) => {
    const { id } = IdParams.parse(request.params);
    await requireDevice(id);
    return { items: await repo.listAssignments(id) };
  });

  // ------------------------------------------------------------------ 1.3 credential lifecycle
  app.post('/v1/devices/:id/revoke', { preHandler: requireAdmin }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const { reason } = RevokeDevice.parse(request.body);
    const device = await requireDevice(id);
    if (device.credentialStatus !== 'active')
      throw conflict('device_not_active', `Device is already ${device.credentialStatus}`);
    const ts = nowIso();
    const updated: Device = {
      ...device,
      credentialStatus: 'revoked',
      revokedAt: ts,
      revocationReason: reason,
      updatedAt: ts,
    };
    await repo.saveDevice(updated);
    await audit({
      tenantId: device.institutionId,
      actorId: actorOf(request),
      actorType: 'admin',
      action: 'device.certificate_revoked',
      resourceType: 'capture_device',
      resourceId: id,
      metadata: { reason, publicKeyFingerprint: device.publicKeyFingerprint },
    });
    return deviceView(updated);
  });

  app.post('/v1/devices/:id/decommission', { preHandler: requireAdmin }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const device = await requireDevice(id);
    const ts = nowIso();
    const active = await repo.getActiveAssignment(id);
    if (active)
      await repo.saveAssignment({
        ...active,
        unassignedAt: ts,
        unassignedBy: actorOf(request) ?? 'system',
      });
    const { classroomId: _c, ...rest } = device;
    const updated: Device = {
      ...rest,
      credentialStatus: 'decommissioned',
      status: 'decommissioned',
      revokedAt: device.revokedAt ?? ts,
      updatedAt: ts,
    };
    await repo.saveDevice(updated);
    await audit({
      tenantId: device.institutionId,
      actorId: actorOf(request),
      actorType: 'admin',
      action: 'device.status_changed',
      resourceType: 'capture_device',
      resourceId: id,
      metadata: { from: device.status, to: 'decommissioned' },
    });
    return deviceView(updated);
  });

  app.put('/v1/devices/:id/maintenance', { preHandler: requireAdmin }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const { enabled } = MaintenanceMode.parse(request.body);
    const device = await requireDevice(id);
    const updated = { ...device, maintenanceMode: enabled, updatedAt: nowIso() };
    await repo.saveDevice(updated);
    await transition(updated);
    return deviceView((await repo.getDevice(id)) ?? updated);
  });

  app.get('/internal/v1/devices/:id/public-key', async (request) => {
    const device = await requireDevice(IdParams.parse(request.params).id);
    return {
      deviceId: device.id,
      publicKeyPem: device.publicKeyPem,
      publicKeyFingerprint: device.publicKeyFingerprint,
      status: device.credentialStatus,
      classroomId: device.classroomId ?? null,
      institutionId: device.institutionId,
    };
  });

  // ------------------------------------------------------------------ heartbeats & health
  /** Persists a derived status change and audits it. */
  async function transition(
    device: Device,
  ): Promise<{ from: DeviceStatus; to: DeviceStatus } | null> {
    const latest = await repo.latestHeartbeat(device.id);
    const { status } = deriveHealth(device, latest, clock.now());
    if (status === device.status) return null;
    await repo.saveDevice({ ...device, status, updatedAt: nowIso() });
    await audit({
      tenantId: device.institutionId,
      actorId: null,
      actorType: 'system',
      action: 'device.status_changed',
      resourceType: 'capture_device',
      resourceId: device.id,
      metadata: { from: device.status, to: status, classroomId: device.classroomId ?? null },
    });
    return { from: device.status, to: status };
  }

  app.post('/v1/devices/:id/heartbeat', { preHandler: deviceAuth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const metrics = HeartbeatBody.parse(request.body);
    const device = await requireDevice(id);
    const receivedAt = nowIso();
    const heartbeat: Heartbeat = {
      id: deps.idGenerator(),
      deviceId: id,
      receivedAt,
      deviceTimestamp: String(request.headers['x-device-timestamp']),
      ...stripUndefined(metrics),
    };
    await repo.addHeartbeat(heartbeat, heartbeatRetention);
    const updated: Device = {
      ...device,
      lastSeenAt: receivedAt,
      firmwareVersion: metrics.firmwareVersion,
      updatedAt: receivedAt,
    };
    await repo.saveDevice(updated);
    await transition(updated);
    const health = deriveHealth(updated, heartbeat, clock.now());
    return {
      status: health.status,
      issues: health.issues,
      serverTime: receivedAt,
      classroomId: device.classroomId ?? null,
      certificateExpiresAt: device.certificateExpiresAt,
    };
  });

  app.get('/v1/fleet/health', { preHandler: requireAdmin }, async (request) => {
    const q = FleetQuery.parse(request.query);
    const filter: { institutionId?: string; classroomId?: string } = {};
    if (q.institutionId) filter.institutionId = q.institutionId;
    if (q.classroomId) filter.classroomId = q.classroomId;
    const rows = await Promise.all((await repo.listDevices(filter)).map(healthRow));
    const byStatus = Object.fromEntries(DEVICE_STATUSES.map((s) => [s, 0])) as Record<
      DeviceStatus,
      number
    >;
    for (const row of rows) byStatus[row['status'] as DeviceStatus] += 1;
    const devices = q.status ? rows.filter((r) => r['status'] === q.status) : rows;
    return {
      generatedAt: nowIso(),
      summary: {
        total: rows.length,
        byStatus,
        withIssues: rows.filter((r) => (r['issues'] as string[]).length > 0).length,
      },
      devices,
    };
  });

  app.get('/v1/devices/:id/health', { preHandler: requireAdmin }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const { limit } = HealthQuery.parse(request.query);
    const device = await requireDevice(id);
    const heartbeats = await repo.listHeartbeats(id, limit);
    return {
      ...(await healthRow(device)),
      heartbeats: heartbeats.map((h) => ({ receivedAt: h.receivedAt, ...metricsOf(h) })),
    };
  });

  // ------------------------------------------------------------------ 1.4 recording plan proxy
  app.get('/v1/devices/:id/recording-plan', { preHandler: deviceAuth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const q = PlanQuery.parse(request.query);
    const device = await requireDevice(id);
    if (!device.classroomId)
      throw conflict('device_unassigned', 'Device is not assigned to a classroom');
    const now = clock.now();
    const from = q.from ?? now.toISOString();
    const to = q.to ?? new Date(now.getTime() + 24 * 3_600_000).toISOString();
    if (Date.parse(to) <= Date.parse(from))
      throw new AppError(400, 'invalid_range', '"to" must be after "from"');
    if (Date.parse(to) - Date.parse(from) > 14 * 86_400_000)
      throw new AppError(400, 'invalid_range', 'Range may not exceed 14 days');
    try {
      return await deps.schedule.getRecordingPlan(device.classroomId, from, to);
    } catch (err) {
      throw upstream(err);
    }
  });

  // ------------------------------------------------------------------ status sweep
  async function sweepStatuses(): Promise<SweepResult> {
    const devices = await repo.listDevices();
    const transitions: SweepResult['transitions'] = [];
    for (const device of devices) {
      if (device.credentialStatus === 'decommissioned') continue;
      const change = await transition(device);
      if (!change) continue;
      transitions.push({ deviceId: device.id, ...change });
      if (change.to === 'offline' && device.lastSeenAt) {
        await publish('device.heartbeat_missed', device.institutionId, {
          deviceId: device.id,
          classroomId: device.classroomId ?? null,
          lastSeenAt: device.lastSeenAt,
        });
      }
    }
    return { checked: devices.length, transitions };
  }

  app.post('/internal/v1/status-sweep', async () => sweepStatuses());

  return { app, deps, sweepStatuses };
}

function upstream(err: unknown): AppError {
  if (err instanceof UpstreamError) {
    return new AppError(502, 'upstream_unavailable', err.message, {
      service: err.service,
      status: err.status,
    });
  }
  return err instanceof AppError
    ? err
    : new AppError(502, 'upstream_unavailable', (err as Error).message);
}

function metricsOf(h: Heartbeat): Record<string, unknown> {
  const { id: _id, deviceId: _d, receivedAt: _r, ...metrics } = h;
  return metrics;
}

type Defined<T> = { [K in keyof T]: Exclude<T[K], undefined> };
function stripUndefined<T extends object>(obj: T): Defined<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Defined<T>;
}
