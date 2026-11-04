import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isLifecycleTimelineAction, validateAction } from './catalog.js';
import {
  CreateContentReportSchema,
  InMemoryContentReportRepository,
  ListContentReportsSchema,
  ResolveContentReportSchema,
  type ContentReport,
  type ContentReportRepository,
} from './content-reports.js';
import { envelope, type EventPublisher } from './events.js';
import { GENESIS_HASH, chainHash } from './chain.js';
import { ACTOR_TYPES, bodyOf, type AuditEvent, type AuditEventBody } from './domain.js';
import { HttpError, installErrorHandler } from './errors.js';
import { tenantKeyOf, type AuditRepository } from './repository.js';

export interface Clock {
  now(): Date;
}

export interface AuditDeps {
  repository: AuditRepository;
  contentReports?: ContentReportRepository;
  events?: EventPublisher;
  clock?: Clock;
  idGenerator?: () => string;
  logger?: boolean;
}

const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s).toISOString());

const uuid = z.string().uuid();

/**
 * Accepts the shapes other services send: `institutionId` as an alias of `tenantId`, and non-UUID
 * actor ids (service names such as "transcription"), which are stored as `actorId: null` with the
 * label kept in `metadata.actorLabel` (the database column is a UUID).
 */
const CreateAuditEventSchema = z
  .object({
    tenantId: uuid.nullable().optional(),
    institutionId: uuid.nullable().optional(),
    actorId: z.string().min(1).max(200).nullable().optional(),
    actorType: z.enum(ACTOR_TYPES).default('system'),
    action: z.string().min(3).max(100),
    resourceType: z.string().min(1).max(100),
    resourceId: uuid.nullable().optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
    occurredAt: isoDate.optional(),
    ipAddress: z.string().ip().nullable().optional(),
  })
  .refine((e) => !e.tenantId || !e.institutionId || e.tenantId === e.institutionId, {
    message: 'tenantId and institutionId differ',
    path: ['institutionId'],
  })
  .transform((e) => {
    const actorIsUuid = e.actorId != null && uuid.safeParse(e.actorId).success;
    const label = e.actorId != null && !actorIsUuid ? { actorLabel: e.actorId } : {};
    const metadata =
      e.metadata || Object.keys(label).length > 0 ? { ...(e.metadata ?? {}), ...label } : undefined;
    return {
      tenantId: e.tenantId ?? e.institutionId ?? undefined,
      actorId: actorIsUuid ? e.actorId : null,
      actorType: e.actorType,
      action: e.action,
      resourceType: e.resourceType,
      resourceId: e.resourceId ?? undefined,
      metadata,
      occurredAt: e.occurredAt,
      ipAddress: e.ipAddress ?? undefined,
    };
  });

const ListQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().uuid().optional(),
  action: z.string().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const encodeCursor = (position: number): string =>
  Buffer.from(String(position)).toString('base64url');
function decodeCursor(cursor: string): number {
  const n = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'invalid_cursor', 'Invalid cursor');
  return n;
}

function present(e: AuditEvent): Omit<AuditEvent, 'position'> {
  return Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'position')) as Omit<
    AuditEvent,
    'position'
  >;
}

export function buildApp(deps: AuditDeps): FastifyInstance {
  const clock = deps.clock ?? { now: () => new Date() };
  const newId = deps.idGenerator ?? randomUUID;
  const repo = deps.repository;
  const app = Fastify({ logger: deps.logger ?? false });
  installErrorHandler(app);

  app.get('/health', () => ({ status: 'ok', service: 'audit' }));

  type AuditInput = z.input<typeof CreateAuditEventSchema>;

  async function append(raw: unknown): Promise<AuditEvent> {
    const input = CreateAuditEventSchema.parse(raw);
    const actionError = validateAction(input.action);
    if (actionError) throw new HttpError(422, 'unknown_action', actionError);
    const tenantId = input.tenantId ?? null;
    const recordedAt = clock.now().toISOString();
    return repo.append(tenantKeyOf(tenantId), (head, position) => {
      const body: AuditEventBody = {
        id: newId(),
        tenantId,
        sequence: head ? head.sequence + 1 : 1,
        actorId: input.actorId ?? null,
        actorType: input.actorType,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        metadata: input.metadata ?? null,
        ipAddress: input.ipAddress ?? null,
        occurredAt: input.occurredAt ?? recordedAt,
        recordedAt,
      };
      const prevHash = head?.hash ?? GENESIS_HASH;
      return { ...body, position, prevHash, hash: chainHash(prevHash, body) };
    });
  }

  app.post('/v1/audit-events', async (req, reply) => {
    const event = await append(req.body);
    return reply.status(201).send(present(event));
  });

  app.get('/v1/audit-events', async (req) => {
    const q = ListQuerySchema.parse(req.query);
    const events = await repo.query({
      ...(q.tenantId !== undefined ? { tenantId: q.tenantId } : {}),
      ...(q.resourceType !== undefined ? { resourceType: q.resourceType } : {}),
      ...(q.resourceId !== undefined ? { resourceId: q.resourceId } : {}),
      ...(q.action !== undefined ? { action: q.action } : {}),
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
      ...(q.cursor !== undefined ? { afterPosition: decodeCursor(q.cursor) } : {}),
      limit: q.limit + 1,
    });
    const page = events.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(present),
      nextCursor: events.length > q.limit && last ? encodeCursor(last.position) : null,
    };
  });

  app.get('/v1/audit-events/verify', async (req) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid().optional() }).parse(req.query);
    const chain = await repo.chain(tenantKeyOf(tenantId ?? null));
    let prevHash = GENESIS_HASH;
    for (const [i, e] of chain.entries()) {
      const expectedSequence = i + 1;
      const recomputed = chainHash(e.prevHash, bodyOf(e));
      let reason: string | null = null;
      if (e.sequence !== expectedSequence) reason = 'sequence_gap';
      else if (e.prevHash !== prevHash) reason = 'prev_hash_mismatch';
      else if (recomputed !== e.hash) reason = 'hash_mismatch';
      if (reason) {
        return {
          tenantId: tenantId ?? null,
          valid: false,
          eventCount: chain.length,
          firstBrokenLink: { eventId: e.id, sequence: e.sequence, reason, expectedSequence },
        };
      }
      prevHash = e.hash;
    }
    return {
      tenantId: tenantId ?? null,
      valid: true,
      eventCount: chain.length,
      headHash: prevHash,
      firstBrokenLink: null,
    };
  });

  app.get('/v1/recordings/:id/lifecycle', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const events = (await repo.forRecording(id))
      .filter((e) => isLifecycleTimelineAction(e.action))
      .sort((a, b) =>
        a.occurredAt === b.occurredAt
          ? a.position - b.position
          : a.occurredAt < b.occurredAt
            ? -1
            : 1,
      );
    return {
      recordingSessionId: id,
      timeline: events.map((e) => ({
        eventId: e.id,
        action: e.action,
        occurredAt: e.occurredAt,
        actorType: e.actorType,
        actorId: e.actorId,
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        metadata: e.metadata,
      })),
    };
  });

  // ---- Content reports (phase-3 contract §7, deliverable 3.15) ----
  const reports = deps.contentReports ?? new InMemoryContentReportRepository();

  async function emit(
    type: string,
    report: ContentReport,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!deps.events) return;
    try {
      await deps.events.publish(envelope(type, 'audit', report.institutionId, data, clock.now()));
    } catch (err) {
      app.log.warn({ err, type }, 'event publication failed');
    }
  }

  const actorTypeOf = (role: ContentReport['reporterRole']): AuditInput['actorType'] => role;
  const resourceIdOf = (id: string): Record<string, string> =>
    z.string().uuid().safeParse(id).success ? { resourceId: id } : {};

  app.post('/v1/content-reports', async (req, reply) => {
    const input = CreateContentReportSchema.parse(req.body);
    const existing = await reports.findOpen(input.reporterId, input.resourceType, input.resourceId);
    if (existing) return reply.status(200).send({ ...existing, duplicate: true });
    const report: ContentReport = {
      id: newId(),
      reporterId: input.reporterId,
      reporterRole: input.reporterRole,
      institutionId: input.institutionId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      classSectionId: input.classSectionId,
      reason: input.reason,
      details: input.details ?? null,
      status: 'open',
      resolution: null,
      resolutionNotes: null,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: clock.now().toISOString(),
    };
    await reports.create(report);
    await append({
      tenantId: report.institutionId,
      actorId: report.reporterId,
      actorType: actorTypeOf(report.reporterRole),
      action: 'content.reported',
      resourceType: report.resourceType,
      ...resourceIdOf(report.resourceId),
      metadata: {
        contentReportId: report.id,
        resourceId: report.resourceId,
        classSectionId: report.classSectionId,
        reason: report.reason,
      },
    });
    await emit('content.reported', report, {
      contentReportId: report.id,
      resourceType: report.resourceType,
      resourceId: report.resourceId,
      classSectionId: report.classSectionId,
      reason: report.reason,
      reporterRole: report.reporterRole,
    });
    return reply.status(201).send(report);
  });

  app.get('/v1/content-reports', async (req) => {
    const q = ListContentReportsSchema.parse(req.query);
    const items = await reports.list({
      ...(q.classSectionId !== undefined ? { classSectionId: q.classSectionId } : {}),
      ...(q.institutionId !== undefined ? { institutionId: q.institutionId } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
      limit: q.limit,
    });
    return { items };
  });

  app.get('/v1/content-reports/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const report = await reports.get(id);
    if (!report)
      throw new HttpError(404, 'content_report_not_found', `Content report ${id} not found`);
    return report;
  });

  app.post('/v1/content-reports/:id/resolve', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const input = ResolveContentReportSchema.parse(req.body);
    const report = await reports.get(id);
    if (!report)
      throw new HttpError(404, 'content_report_not_found', `Content report ${id} not found`);
    if (report.status === 'resolved')
      throw new HttpError(409, 'already_resolved', 'Content report is already resolved');
    const resolved: ContentReport = {
      ...report,
      status: 'resolved',
      resolution: input.resolution,
      resolutionNotes: input.notes ?? null,
      resolvedBy: input.actorId,
      resolvedAt: clock.now().toISOString(),
    };
    await reports.update(resolved);
    await append({
      tenantId: resolved.institutionId,
      actorId: input.actorId,
      actorType: input.actorRole,
      action: 'content.report_resolved',
      resourceType: resolved.resourceType,
      ...resourceIdOf(resolved.resourceId),
      metadata: {
        contentReportId: resolved.id,
        resolution: input.resolution,
        classSectionId: resolved.classSectionId,
      },
    });
    await emit('content.report_resolved', resolved, {
      contentReportId: resolved.id,
      resourceType: resolved.resourceType,
      resourceId: resolved.resourceId,
      classSectionId: resolved.classSectionId,
      resolution: input.resolution,
      reporterId: resolved.reporterId,
    });
    return resolved;
  });

  return app;
}
