import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isGovernedAction, validateAction } from './catalog.js';
import { GENESIS_HASH, chainHash } from './chain.js';
import { ACTOR_TYPES, bodyOf, type AuditEvent, type AuditEventBody } from './domain.js';
import { HttpError, installErrorHandler } from './errors.js';
import { tenantKeyOf, type AuditRepository } from './repository.js';

export interface Clock {
  now(): Date;
}

export interface AuditDeps {
  repository: AuditRepository;
  clock?: Clock;
  idGenerator?: () => string;
  logger?: boolean;
}

const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s).toISOString());

const CreateAuditEventSchema = z.object({
  tenantId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  actorType: z.enum(ACTOR_TYPES).default('system'),
  action: z.string().min(3).max(100),
  resourceType: z.string().min(1).max(100),
  resourceId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
  occurredAt: isoDate.optional(),
  ipAddress: z.string().ip().optional(),
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
  const { position: _position, ...rest } = e;
  return rest;
}

export function buildApp(deps: AuditDeps): FastifyInstance {
  const clock = deps.clock ?? { now: () => new Date() };
  const newId = deps.idGenerator ?? randomUUID;
  const repo = deps.repository;
  const app = Fastify({ logger: deps.logger ?? false });
  installErrorHandler(app);

  app.get('/health', () => ({ status: 'ok', service: 'audit' }));

  app.post('/v1/audit-events', async (req, reply) => {
    const input = CreateAuditEventSchema.parse(req.body);
    const actionError = validateAction(input.action);
    if (actionError) throw new HttpError(422, 'unknown_action', actionError);

    const tenantId = input.tenantId ?? null;
    const recordedAt = clock.now().toISOString();
    const event = await repo.append(tenantKeyOf(tenantId), (head, position) => {
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
      .filter((e) => isGovernedAction(e.action))
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

  return app;
}
