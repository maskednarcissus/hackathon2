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
  type ClassroomInfo,
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
  OPEN_COMMAND_STATUSES,
  type Device,
  type DeviceCommand,
  type DeviceStatus,
  type Heartbeat,
  type ProvisioningToken,
} from './domain.js';
import {
  backlogTrend,
  certificateReport,
  commandView,
  compareVersions,
  computeUptime,
  firmwareDistribution,
  firmwareHistory,
  type FleetRow,
} from './fleet.js';
import {
  AppError,
  conflict,
  forbidden,
  notFound,
  registerErrorHandler,
  unauthorized,
} from './errors.js';
import { deriveHealth } from './health.js';
import {
  InMemoryDeviceRepository,
  RepositoryConflictError,
  type DeviceRepository,
} from './repository.js';
import {
  AssignDevice,
  CommandCancel,
  CommandCreate,
  CommandListQuery,
  CommandParams,
  CommandResult,
  DiagnosticsQuery,
  FirmwareQuery,
  FleetConsoleQuery,
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
import { createInternalGuard } from './internal-auth.js';
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
  /** When set, `/internal/*` routes (incl. the status sweep) require `x-internal-token`. */
  internalToken?: string;
  certificateValidityDays?: number;
  heartbeatRetention?: number;
  /** Nominal firmware heartbeat interval, used for missed-heartbeat counts (default 60 s). */
  heartbeatIntervalSeconds?: number;
  /** Open (pending/delivered) commands allowed per device (default 10). */
  maxOpenCommandsPerDevice?: number;
  logger?: FastifyServerOptions['logger'];
  /** Pre-built pino logger (takes precedence over `logger`). */
  loggerInstance?: FastifyBaseLogger;
}

export interface SweepResult {
  checked: number;
  transitions: { deviceId: string; from: DeviceStatus; to: DeviceStatus }[];
  expiredCommands: number;
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
  const heartbeatIntervalSeconds = options.heartbeatIntervalSeconds ?? 60;
  const maxOpenCommands = options.maxOpenCommandsPerDevice ?? 10;

  const app: FastifyInstance = options.loggerInstance
    ? (Fastify({
        loggerInstance: options.loggerInstance,
        bodyLimit: 256 * 1024,
      }) as unknown as FastifyInstance)
    : Fastify({ logger: options.logger ?? false, bodyLimit: 256 * 1024 });
  registerErrorHandler(app);
  const requireInternal = createInternalGuard(options.internalToken);
  app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/internal/')) await requireInternal(request);
  });

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
    return omit(d, ['publicKeyPem', 'certificate']);
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
    if (!(await repo.registerDevice(token.id, now.toISOString(), device))) {
      throw unauthorized('provisioning_token_used', 'Provisioning token was already used');
    }

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
    const assignment = {
      id: deps.idGenerator(),
      deviceId: id,
      classroomId,
      institutionId: classroom.institutionId,
      assignedAt: ts,
      assignedBy: actor,
    };
    try {
      await repo.applyAssignment({
        device: { ...device, classroomId, updatedAt: ts },
        ...(current ? { close: { ...current, unassignedAt: ts, unassignedBy: actor } } : {}),
        open: assignment,
      });
    } catch (err) {
      if (err instanceof RepositoryConflictError) {
        throw conflict('classroom_occupied', 'Classroom already has an active capture device');
      }
      throw err;
    }

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
    await repo.applyAssignment({
      device: { ...omit(device, ['classroomId']), updatedAt: ts },
      close: { ...current, unassignedAt: ts, unassignedBy: actorOf(request) ?? 'system' },
    });
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
    const updated: Device = {
      ...omit(device, ['classroomId']),
      credentialStatus: 'decommissioned',
      status: 'decommissioned',
      revokedAt: device.revokedAt ?? ts,
      updatedAt: ts,
    };
    await repo.applyAssignment({
      device: updated,
      ...(active
        ? { close: { ...active, unassignedAt: ts, unassignedBy: actorOf(request) ?? 'system' } }
        : {}),
    });
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
    const commands = await deliverCommands(id);
    return {
      status: health.status,
      issues: health.issues,
      serverTime: receivedAt,
      classroomId: device.classroomId ?? null,
      certificateExpiresAt: device.certificateExpiresAt,
      commands: commands.map((c) => ({
        commandId: c.id,
        type: c.type,
        issuedAt: c.issuedAt,
        expiresAt: c.expiresAt,
      })),
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

  // ------------------------------------------------------------------ 4.7 remote commands
  /** Marks an open command past its expiry as expired (audited). Returns true when it expired. */
  async function expireIfDue(command: DeviceCommand): Promise<boolean> {
    if (!OPEN_COMMAND_STATUSES.includes(command.status)) return false;
    if (Date.parse(command.expiresAt) > clock.now().getTime()) return false;
    await repo.saveCommand({ ...command, status: 'expired' });
    await audit({
      tenantId: command.institutionId,
      actorId: null,
      actorType: 'system',
      action: 'device.command_expired',
      resourceType: 'device_command',
      resourceId: command.id,
      metadata: {
        deviceId: command.deviceId,
        type: command.type,
        delivered: Boolean(command.deliveredAt),
      },
    });
    return true;
  }

  /** Open, unexpired commands for a device, oldest first. */
  async function openCommands(deviceId: string): Promise<DeviceCommand[]> {
    const open = await repo.listCommands({ deviceId, statuses: OPEN_COMMAND_STATUSES });
    const live: DeviceCommand[] = [];
    for (const c of open) if (!(await expireIfDue(c))) live.push(c);
    return live.reverse();
  }

  /**
   * Hands every open command to the device. Delivered-but-unanswered commands are re-sent until
   * they expire (the heartbeat response may have been lost); the device de-duplicates by id.
   */
  async function deliverCommands(deviceId: string): Promise<DeviceCommand[]> {
    const ts = nowIso();
    const live = await openCommands(deviceId);
    const delivered: DeviceCommand[] = [];
    for (const c of live) {
      const next: DeviceCommand = {
        ...c,
        status: 'delivered',
        deliveredAt: c.deliveredAt ?? ts,
        deliveryCount: c.deliveryCount + 1,
      };
      await repo.saveCommand(next);
      delivered.push(next);
    }
    return delivered;
  }

  const requireCommand = async (deviceId: string, commandId: string): Promise<DeviceCommand> => {
    const command = await repo.getCommand(commandId);
    if (!command || command.deviceId !== deviceId) throw notFound('Command', commandId);
    return command;
  };

  app.post('/v1/devices/:id/commands', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = CommandCreate.parse(request.body);
    const device = await requireDevice(id);
    if (device.credentialStatus !== 'active') {
      throw conflict('device_not_active', `Cannot command a ${device.credentialStatus} device`);
    }
    const open = await openCommands(id);
    const duplicate = open.find((c) => c.type === body.type);
    if (duplicate) {
      // Idempotent: a second request for the same open command returns the existing one.
      return reply.status(202).send({
        commandId: duplicate.id,
        status: duplicate.status,
        expiresAt: duplicate.expiresAt,
        deduplicated: true,
      });
    }
    if (open.length >= maxOpenCommands) {
      throw new AppError(
        429,
        'too_many_commands',
        `Device already has ${open.length} open commands`,
      );
    }
    const now = clock.now();
    const command: DeviceCommand = {
      id: deps.idGenerator(),
      deviceId: id,
      institutionId: device.institutionId,
      type: body.type,
      status: 'pending',
      requestedBy: body.requestedBy,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + body.ttlMinutes * 60_000).toISOString(),
      deliveryCount: 0,
    };
    // The repository re-checks atomically (concurrent requests for the same type).
    const stored = await repo.createCommand(command);
    if (!stored.created) {
      return reply.status(202).send({
        commandId: stored.command.id,
        status: stored.command.status,
        expiresAt: stored.command.expiresAt,
        deduplicated: true,
      });
    }
    await audit({
      tenantId: device.institutionId,
      actorId: body.requestedBy,
      actorType: 'admin',
      action: 'device.command_issued',
      resourceType: 'device_command',
      resourceId: command.id,
      metadata: { deviceId: id, type: body.type, expiresAt: command.expiresAt },
    });
    return reply
      .status(202)
      .send({ commandId: command.id, status: command.status, expiresAt: command.expiresAt });
  });

  app.get('/v1/devices/:id/commands', { preHandler: requireAdmin }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const q = CommandListQuery.parse(request.query);
    await requireDevice(id);
    for (const c of await repo.listCommands({ deviceId: id, statuses: OPEN_COMMAND_STATUSES }))
      await expireIfDue(c);
    const items = await repo.listCommands(
      { deviceId: id, ...(q.status ? { statuses: [q.status] } : {}) },
      q.limit,
    );
    return { items: items.map(commandView) };
  });

  app.get('/v1/devices/:id/commands/:commandId', { preHandler: requireAdmin }, async (request) => {
    const { id, commandId } = CommandParams.parse(request.params);
    const command = await requireCommand(id, commandId);
    await expireIfDue(command);
    return commandView((await repo.getCommand(commandId)) ?? command);
  });

  app.post(
    '/v1/devices/:id/commands/:commandId/cancel',
    { preHandler: requireAdmin },
    async (request) => {
      const { id, commandId } = CommandParams.parse(request.params);
      const body = CommandCancel.parse(request.body ?? {});
      const command = await requireCommand(id, commandId);
      if ((await expireIfDue(command)) || !OPEN_COMMAND_STATUSES.includes(command.status)) {
        const current = (await repo.getCommand(commandId)) ?? command;
        throw conflict('command_not_open', `Command is ${current.status}`);
      }
      const actor = body.actorId ?? actorOf(request);
      const updated: DeviceCommand = {
        ...command,
        status: 'cancelled',
        cancelledAt: nowIso(),
        ...(actor ? { cancelledBy: actor } : {}),
      };
      await repo.saveCommand(updated);
      await audit({
        tenantId: command.institutionId,
        actorId: actor,
        actorType: 'admin',
        action: 'device.command_cancelled',
        resourceType: 'device_command',
        resourceId: commandId,
        metadata: { deviceId: id, type: command.type, wasDelivered: Boolean(command.deliveredAt) },
      });
      return commandView(updated);
    },
  );

  app.post(
    '/v1/devices/:id/commands/:commandId/result',
    { preHandler: deviceAuth },
    async (request) => {
      const { id, commandId } = CommandParams.parse(request.params);
      const body = CommandResult.parse(request.body);
      const command = await requireCommand(id, commandId);
      if (command.status === 'succeeded' || command.status === 'failed') {
        if (command.status === body.status && command.finishedAt === body.finishedAt) {
          return commandView(command); // retried report
        }
        throw conflict('command_already_finished', `Command already ${command.status}`);
      }
      if (command.status === 'cancelled')
        throw conflict('command_cancelled', 'Command was cancelled');
      if (!command.deliveredAt) {
        throw conflict('command_not_delivered', 'Command was never delivered to this device');
      }
      // A delivered command may finish after expiry (e.g. a slow self-test); its result is kept.
      if (Date.parse(body.finishedAt) > clock.now().getTime() + 300_000) {
        throw new AppError(400, 'invalid_finished_at', 'finishedAt is in the future');
      }
      const updated: DeviceCommand = {
        ...command,
        status: body.status,
        finishedAt: body.finishedAt,
        resultReceivedAt: nowIso(),
        ...(body.output !== undefined ? { output: body.output } : {}),
      };
      await repo.saveCommand(updated);
      await audit({
        tenantId: command.institutionId,
        actorId: id,
        actorType: 'device',
        action: 'device.command_completed',
        resourceType: 'device_command',
        resourceId: commandId,
        metadata: {
          deviceId: id,
          type: command.type,
          status: body.status,
          finishedAt: body.finishedAt,
        },
      });
      return commandView(updated);
    },
  );

  // ------------------------------------------------------------------ 4.7 fleet console
  app.get('/v1/fleet', { preHandler: requireAdmin }, async (request) => {
    const q = FleetConsoleQuery.parse(request.query);
    const devices = await repo.listDevices(
      q.institutionId ? { institutionId: q.institutionId } : {},
    );
    const rooms = new Map<string, ClassroomInfo | null>();
    let namesUnavailable = false;
    const roomOf = async (classroomId: string | undefined): Promise<ClassroomInfo | null> => {
      if (!classroomId) return null;
      if (!rooms.has(classroomId)) {
        try {
          rooms.set(classroomId, await deps.organization.getClassroom(classroomId));
        } catch (err) {
          namesUnavailable = true;
          app.log.warn({ err, classroomId }, 'classroom lookup failed; names omitted');
          rooms.set(classroomId, null);
        }
      }
      return rooms.get(classroomId) ?? null;
    };

    const rows: FleetRow[] = [];
    for (const device of devices) {
      const latest = await repo.latestHeartbeat(device.id);
      const health = deriveHealth(device, latest, clock.now());
      const room = await roomOf(device.classroomId);
      rows.push({
        deviceId: device.id,
        serialNumber: device.serialNumber,
        model: device.model,
        firmwareVersion: device.firmwareVersion,
        institutionId: device.institutionId,
        status: health.status,
        issues: health.issues,
        lastSeenAt: device.lastSeenAt ?? null,
        classroom: device.classroomId
          ? { id: device.classroomId, name: room?.name ?? null, code: room?.code ?? null }
          : null,
        campus: room ? { id: room.campusId, name: room.campusName ?? null } : null,
        metrics: latest
          ? {
              diskFreeBytes: latest.diskFreeBytes,
              bufferQueueCount: latest.bufferQueueCount,
              cpuTempC: latest.cpuTempC ?? null,
              isRecording: latest.isRecording,
            }
          : null,
        openCommands: (
          await repo.listCommands({ deviceId: device.id, statuses: OPEN_COMMAND_STATUSES })
        ).length,
      });
    }

    const needle = q.q?.toLocaleLowerCase('pt-BR');
    const matches = rows.filter(
      (r) =>
        (!q.campusId || r.campus?.id === q.campusId) &&
        (!q.firmwareVersion || r.firmwareVersion === q.firmwareVersion) &&
        (!needle ||
          [r.serialNumber, r.model, r.classroom?.name, r.classroom?.code, r.campus?.name]
            .filter((v): v is string => typeof v === 'string')
            .some((v) => v.toLocaleLowerCase('pt-BR').includes(needle))),
    );
    const byStatus = Object.fromEntries(DEVICE_STATUSES.map((st) => [st, 0])) as Record<
      DeviceStatus,
      number
    >;
    for (const r of matches) byStatus[r.status] += 1;
    const filtered = q.status ? matches.filter((r) => r.status === q.status) : matches;

    const desc = q.sort.startsWith('-');
    const field = desc ? q.sort.slice(1) : q.sort;
    const key = (r: FleetRow): string => {
      switch (field) {
        case 'status':
          return String(DEVICE_STATUSES.indexOf(r.status)).padStart(2, '0');
        case 'lastSeenAt':
          return r.lastSeenAt ?? '';
        case 'classroom':
          return r.classroom?.name ?? r.classroom?.code ?? '';
        case 'campus':
          return r.campus?.name ?? '';
        default:
          return r.serialNumber;
      }
    };
    filtered.sort((a, b) => {
      const cmp =
        field === 'firmwareVersion'
          ? compareVersions(a.firmwareVersion, b.firmwareVersion)
          : key(a).localeCompare(key(b), 'pt-BR');
      return (desc ? -cmp : cmp) || a.serialNumber.localeCompare(b.serialNumber);
    });

    const total = filtered.length;
    const start = (q.page - 1) * q.pageSize;
    return {
      generatedAt: nowIso(),
      page: q.page,
      pageSize: q.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
      summary: { total: matches.length, byStatus },
      namesUnavailable,
      items: filtered.slice(start, start + q.pageSize),
    };
  });

  app.get('/v1/fleet/firmware', { preHandler: requireAdmin }, async (request) => {
    const q = FirmwareQuery.parse(request.query);
    const devices = await repo.listDevices(
      q.institutionId ? { institutionId: q.institutionId } : {},
    );
    return firmwareDistribution(devices, clock.now());
  });

  app.get('/v1/devices/:id/diagnostics', { preHandler: requireAdmin }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const { windowHours } = DiagnosticsQuery.parse(request.query);
    const device = await requireDevice(id);
    const now = clock.now();
    const since = new Date(now.getTime() - windowHours * 3_600_000 - 3_600_000).toISOString();
    const heartbeats = await repo.listHeartbeatsSince(id, since);
    const latest = await repo.latestHeartbeat(id);
    const health = deriveHealth(device, latest, now);
    for (const c of await repo.listCommands({ deviceId: id, statuses: OPEN_COMMAND_STATUSES }))
      await expireIfDue(c);
    return {
      deviceId: device.id,
      serialNumber: device.serialNumber,
      model: device.model,
      institutionId: device.institutionId,
      classroomId: device.classroomId ?? null,
      status: health.status,
      issues: health.issues,
      lastSeenAt: device.lastSeenAt ?? null,
      latestHeartbeat: latest ? { receivedAt: latest.receivedAt, ...metricsOf(latest) } : null,
      uptime: computeUptime(heartbeats, device, now, windowHours, heartbeatIntervalSeconds),
      backlogTrend: backlogTrend(heartbeats, now, windowHours),
      firmware: { current: device.firmwareVersion, history: firmwareHistory(heartbeats) },
      certificate: certificateReport(device, now),
      lastCommands: (await repo.listCommands({ deviceId: id }, 10)).map(commandView),
    };
  });

  // ------------------------------------------------------------------ status sweep
  async function sweepStatuses(): Promise<SweepResult> {
    let expiredCommands = 0;
    for (const command of await repo.listCommands({ statuses: OPEN_COMMAND_STATUSES })) {
      if (await expireIfDue(command)) expiredCommands += 1;
    }
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
    return { checked: devices.length, transitions, expiredCommands };
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
  return omit(h, ['id', 'deviceId', 'receivedAt']);
}

export function omit<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  const copy: Partial<T> = { ...obj };
  for (const key of keys) delete copy[key];
  return copy as Omit<T, K>;
}

type Defined<T> = { [K in keyof T]: Exclude<T[K], undefined> };
function stripUndefined<T extends object>(obj: T): Defined<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Defined<T>;
}
