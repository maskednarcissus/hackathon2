import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditClient, AuditEventInput } from './audit-client.js';
import {
  DSR_CHANNELS,
  DSR_STATUSES,
  DSR_TYPES,
  DsrError,
  DsrService,
  resolveSubjectUser,
  SUBJECT_TYPES,
  type DsrDeps,
  type DsrRequest,
  type DsrView,
} from './dsr.js';
import { AppError, forbidden, parseOrThrow, unauthorized } from './errors.js';
import type { AccessTokenClaims } from './jwt-verify.js';
import type { Repositories, UserRecord } from './repositories.js';
import type { Clock } from './tokens.js';

export interface DsrRouteDeps {
  repos: Repositories;
  clock: Clock;
  audit: AuditClient;
  dsr: DsrDeps;
  hasInternalToken: (request: FastifyRequest) => boolean;
  optionalBearer: (request: FastifyRequest) => Promise<AccessTokenClaims | undefined>;
}

const uuid = z.string().uuid();

const CreateSchema = z.object({
  subjectType: z.enum(SUBJECT_TYPES),
  subjectId: uuid,
  institutionId: uuid,
  type: z.enum(DSR_TYPES),
  requestedBy: uuid,
  channel: z.enum(DSR_CHANNELS),
  details: z.record(z.unknown()).optional(),
});
const IdParams = z.object({ id: uuid });
const ActorSchema = z.object({ actorId: uuid.optional() });
const VerifySchema = ActorSchema.extend({
  method: z.string().trim().min(1).max(200).default('staff_verified'),
  notes: z.string().max(2000).optional(),
});
const RejectSchema = ActorSchema.extend({ reason: z.string().trim().min(3).max(2000) });
const ListQuery = z.object({
  status: z.enum(DSR_STATUSES).optional(),
  institutionId: uuid.optional(),
  overdue: z.enum(['true', 'false']).optional(),
});

type Caller = { kind: 'internal' } | { kind: 'user'; claims: AccessTokenClaims };

const isStaff = (claims: AccessTokenClaims): boolean =>
  claims.role === 'admin' || claims.role === 'coordinator';

function isSubject(claims: AccessTokenClaims, subjectUser: Pick<UserRecord, 'id'>): boolean {
  return claims.sub === subjectUser.id;
}

const serialize = (view: DsrView): Record<string, unknown> => ({
  ...view.request,
  receivedAt: view.request.receivedAt.toISOString(),
  dueAt: view.request.dueAt.toISOString(),
  overdue: view.overdue,
  daysRemaining: view.daysRemaining,
});

export function registerDsrRoutes(app: FastifyInstance, deps: DsrRouteDeps): DsrService {
  const service = new DsrService(deps.dsr, deps.repos, () => deps.clock.now());

  const caller = async (request: FastifyRequest): Promise<Caller> => {
    if (deps.hasInternalToken(request)) return { kind: 'internal' };
    const claims = await deps.optionalBearer(request);
    if (!claims) throw unauthorized('Bearer token or internal token required');
    return { kind: 'user', claims };
  };

  /** Staff of the institution (or a service). Returns the acting user id, if any. */
  const requireStaff = async (
    request: FastifyRequest,
    institutionId: string,
  ): Promise<string | null> => {
    const c = await caller(request);
    if (c.kind === 'internal') return null;
    if (!isStaff(c.claims)) throw forbidden('Coordinator or admin role required');
    if (c.claims.inst !== institutionId)
      throw forbidden('Cross-institution access denied', 'cross_institution');
    return c.claims.sub;
  };

  const audit = async (
    request: DsrRequest,
    action: AuditEventInput['action'],
    actorId: string | null,
    metadata: Record<string, unknown> = {},
  ): Promise<void> => {
    await deps.audit.record({
      tenantId: request.institutionId,
      ...(actorId ? { actorId } : {}),
      actorType: actorId
        ? ((await deps.repos.users.findById(actorId))?.role ?? 'system')
        : 'system',
      action,
      resourceType: 'dsr_request',
      resourceId: request.id,
      // Never the subject's data itself: only identifiers and workflow facts.
      metadata: { type: request.type, subjectType: request.subjectType, ...metadata },
    });
  };

  const mapErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof DsrError) throw new AppError(err.statusCode, err.code, err.message);
      throw err;
    }
  };

  const actorFrom = (resolved: string | null, bodyActor: string | undefined): string | null =>
    resolved ?? bodyActor ?? null;

  app.post('/v1/dsr', async (request, reply) => {
    const body = parseOrThrow(CreateSchema, request.body);
    const c = await caller(request);
    const subjectUser = await resolveSubjectUser(deps.repos, body);
    let requestedBy = body.requestedBy;

    if (c.kind === 'user') {
      if (c.claims.inst !== body.institutionId) {
        throw forbidden('Cross-institution access denied', 'cross_institution');
      }
      const self = subjectUser !== undefined && isSubject(c.claims, subjectUser);
      if (!isStaff(c.claims) && !self) {
        throw forbidden('Only the data subject or institution staff may file a request');
      }
      if (self && !isStaff(c.claims)) requestedBy = c.claims.sub;
    }
    if (!subjectUser) {
      throw new AppError(
        422,
        'subject_not_in_institution',
        'The data subject does not belong to this institution',
      );
    }

    const created = await mapErrors(() =>
      service.create({
        institutionId: body.institutionId,
        subjectType: body.subjectType,
        subjectId: body.subjectId,
        subjectUserId: subjectUser.id,
        type: body.type,
        requestedBy,
        channel: body.channel,
        details: body.details ?? null,
      }),
    );
    await audit(created, 'dsr.received', c.kind === 'user' ? c.claims.sub : null, {
      channel: created.channel,
    });
    return reply.status(201).send({
      id: created.id,
      status: created.status,
      dueAt: created.dueAt.toISOString(),
    });
  });

  app.get('/v1/dsr', async (request) => {
    const query = parseOrThrow(ListQuery, request.query);
    const c = await caller(request);
    let institutionId = query.institutionId;
    if (c.kind === 'user') {
      if (!isStaff(c.claims)) throw forbidden('Coordinator or admin role required');
      if (institutionId !== undefined && institutionId !== c.claims.inst) {
        throw forbidden('Cross-institution access denied', 'cross_institution');
      }
      institutionId = c.claims.inst;
    } else if (institutionId === undefined) {
      throw new AppError(400, 'validation_error', 'institutionId is required for service callers');
    }
    const requests = await deps.dsr.repo.list({
      institutionId,
      ...(query.status ? { status: query.status } : {}),
    });
    let views = requests.map((r) => service.view(r));
    if (query.overdue !== undefined)
      views = views.filter((v) => v.overdue === (query.overdue === 'true'));
    return {
      items: views.map(serialize),
      summary: {
        total: views.length,
        overdue: views.filter((v) => v.overdue).length,
      },
    };
  });

  app.get('/v1/dsr/:id', async (request) => {
    const { id } = parseOrThrow(IdParams, request.params);
    const c = await caller(request);
    const dsr = await deps.dsr.repo.get(id);
    if (!dsr) throw new AppError(404, 'not_found', 'DSR request not found');
    if (c.kind === 'user') {
      const staffOk = isStaff(c.claims) && c.claims.inst === dsr.institutionId;
      const selfOk = c.claims.sub === dsr.subjectUserId;
      if (!staffOk && !selfOk) throw new AppError(404, 'not_found', 'DSR request not found');
    }
    const [results, events] = await Promise.all([
      deps.dsr.repo.listResults(id),
      deps.dsr.repo.listEvents(id),
    ]);
    return {
      ...serialize(service.view(dsr)),
      results: results.map((r) => ({
        service: r.service,
        status: r.status,
        attempts: r.attempts,
        items: r.items,
        exportUri: r.exportUri,
        error: r.error,
        lastAttemptAt: r.lastAttemptAt?.toISOString() ?? null,
        completedAt: r.completedAt?.toISOString() ?? null,
      })),
      pendingServices: service.handlerNames.filter(
        (name) =>
          !results.some(
            (r) =>
              r.service === name && (r.status === 'completed' || r.status === 'not_applicable'),
          ),
      ),
      timeline: events.map((e) => ({ ...e, at: e.at.toISOString() })),
    };
  });

  app.get('/v1/dsr/:id/export', async (request) => {
    const { id } = parseOrThrow(IdParams, request.params);
    const c = await caller(request);
    const dsr = await deps.dsr.repo.get(id);
    if (!dsr) throw new AppError(404, 'not_found', 'DSR request not found');
    if (c.kind === 'user') {
      const staffOk = isStaff(c.claims) && c.claims.inst === dsr.institutionId;
      if (!staffOk && c.claims.sub !== dsr.subjectUserId) {
        throw new AppError(404, 'not_found', 'DSR request not found');
      }
    }
    if (!dsr.exportUri)
      throw new AppError(404, 'export_not_available', 'No export for this request');
    const bundle = await deps.dsr.exportStore.get(dsr.exportUri);
    if (bundle === undefined) throw new AppError(404, 'export_not_available', 'Export not found');
    return bundle;
  });

  app.post('/v1/dsr/:id/verify', async (request) => {
    const { id } = parseOrThrow(IdParams, request.params);
    const body = parseOrThrow(VerifySchema, request.body ?? {});
    const dsr = await deps.dsr.repo.get(id);
    if (!dsr) throw new AppError(404, 'not_found', 'DSR request not found');
    const actor = actorFrom(await requireStaff(request, dsr.institutionId), body.actorId);
    if (!actor)
      throw new AppError(400, 'validation_error', 'actorId is required for service callers');
    const updated = await mapErrors(() => service.verify(id, actor, body.method, body.notes));
    await audit(updated, 'dsr.verified', actor, { method: body.method });
    return serialize(service.view(updated));
  });

  app.post('/v1/dsr/:id/reject', async (request) => {
    const { id } = parseOrThrow(IdParams, request.params);
    const body = parseOrThrow(RejectSchema, request.body);
    const dsr = await deps.dsr.repo.get(id);
    if (!dsr) throw new AppError(404, 'not_found', 'DSR request not found');
    const actor = actorFrom(await requireStaff(request, dsr.institutionId), body.actorId);
    if (!actor)
      throw new AppError(400, 'validation_error', 'actorId is required for service callers');
    const updated = await mapErrors(() => service.reject(id, actor, body.reason));
    await audit(updated, 'dsr.rejected', actor, { reason: body.reason });
    return serialize(service.view(updated));
  });

  app.post('/v1/dsr/:id/execute', async (request) => {
    const { id } = parseOrThrow(IdParams, request.params);
    const body = parseOrThrow(ActorSchema, request.body ?? {});
    const dsr = await deps.dsr.repo.get(id);
    if (!dsr) throw new AppError(404, 'not_found', 'DSR request not found');
    const actor = actorFrom(await requireStaff(request, dsr.institutionId), body.actorId);
    if (!actor)
      throw new AppError(400, 'validation_error', 'actorId is required for service callers');
    const outcome = await mapErrors(() => service.execute(id, actor));
    if (dsr.status === 'verifying') {
      await audit(outcome.request, 'dsr.execution_started', actor, {
        services: outcome.ranServices,
      });
    }
    if (outcome.request.status === 'completed') {
      await audit(outcome.request, 'dsr.completed', actor, {
        attempts: outcome.request.executionAttempts,
        exported: outcome.request.exportUri !== null,
      });
    } else {
      await audit(outcome.request, 'dsr.execution_partial', actor, {
        failed: outcome.results.filter((r) => r.status === 'failed').map((r) => r.service),
      });
    }
    return {
      ...serialize(service.view(outcome.request)),
      ranServices: outcome.ranServices,
      results: outcome.results.map((r) => ({
        service: r.service,
        status: r.status,
        attempts: r.attempts,
        error: r.error,
      })),
    };
  });

  return service;
}
