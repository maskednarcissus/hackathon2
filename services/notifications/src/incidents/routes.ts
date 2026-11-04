import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ALERT_RULES, RESOLUTION_CODES, SEVERITIES, type Alert } from '../domain.js';
import { IncidentError, type AlertEngine } from '../engine.js';
import { HttpError, parse } from '../http.js';
import type { AlertStore } from '../store.js';
import { scopeInstitution, type AdminPrincipal } from './auth.js';
import {
  computeStats,
  sortIncidents,
  toIncident,
  toIncidentDetail,
  type IncidentDetailView,
} from './view.js';

export interface IncidentRouteDeps {
  engine: AlertEngine;
  store: AlertStore;
  clock: () => Date;
  authenticate: (req: import('fastify').FastifyRequest) => Promise<AdminPrincipal>;
}

const actor = z.string().min(1).max(100);
const ListQuery = z.object({
  institutionId: z.string().uuid().optional(),
  status: z.enum(['open', 'acknowledged', 'in_progress', 'resolved']).optional(),
  severity: z.enum(SEVERITIES).optional(),
  type: z.enum(ALERT_RULES).optional(),
  campusId: z.string().min(1).max(100).optional(),
  assignee: z.string().min(1).max(100).optional(),
  sort: z.enum(['severity', 'age']).default('severity'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const StatsQuery = z
  .object({
    institutionId: z.string().uuid().optional(),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  })
  .refine((q) => new Date(q.from) < new Date(q.to), 'from must be before to');
const IdParams = z.object({ id: z.string().uuid() });
const AssignBody = z.object({ assigneeId: actor, actorId: actor });
const CommentBody = z.object({ actorId: actor, body: z.string().trim().min(1).max(5000) });
const StatusBody = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('acknowledged'),
    actorId: actor,
    note: z.string().max(2000).optional(),
  }),
  z.object({
    status: z.literal('in_progress'),
    actorId: actor,
    note: z.string().max(2000).optional(),
  }),
  z.object({
    status: z.literal('resolved'),
    actorId: actor,
    resolutionCode: z.enum(RESOLUTION_CODES, {
      errorMap: () => ({ message: `resolutionCode must be one of ${RESOLUTION_CODES.join(', ')}` }),
    }),
    note: z.string().max(2000).optional(),
  }),
]);

export function registerIncidentRoutes(app: FastifyInstance, deps: IncidentRouteDeps): void {
  const { engine, store, clock } = deps;

  /** Wrap engine errors; enforce institution scope on single-incident routes. */
  const loadScoped = async (principal: AdminPrincipal, id: string): Promise<Alert> => {
    const alert = await engine.get(id);
    if (!alert) throw new HttpError(404, 'not_found', 'Incident not found');
    if (principal.institutionId !== null && alert.institutionId !== principal.institutionId) {
      throw new HttpError(404, 'not_found', 'Incident not found');
    }
    return alert;
  };
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof IncidentError) throw new HttpError(err.statusCode, err.code, err.message);
      throw err;
    }
  };
  /** JWT callers act as themselves; the static token trusts the body's actorId. */
  const actorOf = (p: AdminPrincipal, bodyActor: string): string => p.userId ?? bodyActor;

  const detail = async (alert: Alert): Promise<IncidentDetailView> =>
    toIncidentDetail(
      alert,
      await store.comments(alert.id),
      await store.activity(alert.id),
      clock(),
    );

  app.get('/v1/incidents', async (req) => {
    const principal = await deps.authenticate(req);
    const q = parse(ListQuery, req.query);
    const alerts = await store.query({
      institutionId: scopeInstitution(principal, q.institutionId),
      status: q.status,
      severity: q.severity,
      rule: q.type,
      campusId: q.campusId,
      assignee: q.assignee,
    });
    const now = clock();
    const sorted = sortIncidents(
      alerts.map((a) => toIncident(a, now)),
      q.sort,
    );
    return { items: sorted.slice(q.offset, q.offset + q.limit), total: sorted.length };
  });

  // registered before /:id so "stats" is not parsed as an id
  app.get('/v1/incidents/stats', async (req) => {
    const principal = await deps.authenticate(req);
    const q = parse(StatsQuery, req.query);
    const institutionId = scopeInstitution(principal, q.institutionId);
    const from = new Date(q.from).toISOString();
    const to = new Date(q.to).toISOString();
    const inRange = await store.query({ institutionId, raisedFrom: from, raisedTo: to });
    const all = await store.query({ institutionId });
    const open = all.filter((a) => a.status !== 'resolved');
    return computeStats(inRange, open, { institutionId: institutionId ?? null, from, to }, clock());
  });

  app.get('/v1/incidents/:id', async (req) => {
    const principal = await deps.authenticate(req);
    const { id } = parse(IdParams, req.params);
    return detail(await loadScoped(principal, id));
  });

  app.post('/v1/incidents/:id/assign', async (req) => {
    const principal = await deps.authenticate(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(AssignBody, req.body);
    await loadScoped(principal, id);
    return detail(
      await run(() => engine.assign(id, body.assigneeId, actorOf(principal, body.actorId))),
    );
  });

  app.post('/v1/incidents/:id/status', async (req) => {
    const principal = await deps.authenticate(req);
    const { id } = parse(IdParams, req.params);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    if (raw.status === 'resolved' && raw.resolutionCode === undefined) {
      throw new HttpError(
        422,
        'resolution_code_required',
        'resolutionCode is required to resolve an incident',
        {
          allowed: RESOLUTION_CODES,
        },
      );
    }
    const body = parse(StatusBody, req.body);
    const current = await loadScoped(principal, id);
    const who = actorOf(principal, body.actorId);
    if (current.status === 'resolved') {
      throw new HttpError(409, 'incident_resolved', 'Incident is already resolved');
    }
    let updated: Alert | undefined;
    if (body.status === 'acknowledged') {
      if (current.status === 'in_progress') {
        throw new HttpError(409, 'invalid_transition', 'Incident is already in progress');
      }
      updated = await engine.acknowledge(id, who, body.note);
    } else if (body.status === 'in_progress') {
      updated = await run(() => engine.startProgress(id, who, body.note));
    } else {
      updated = await engine.resolve(id, who, body.note, body.resolutionCode);
    }
    if (!updated) throw new HttpError(404, 'not_found', 'Incident not found');
    return detail(updated);
  });

  app.post('/v1/incidents/:id/comments', async (req, reply) => {
    const principal = await deps.authenticate(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(CommentBody, req.body);
    await loadScoped(principal, id);
    const { alert, comment } = await run(() =>
      engine.comment(id, actorOf(principal, body.actorId), body.body),
    );
    return reply.status(201).send({
      comment: {
        id: comment.id,
        actorId: comment.actorId,
        body: comment.body,
        createdAt: comment.createdAt,
      },
      incident: await detail(alert),
    });
  });
}
