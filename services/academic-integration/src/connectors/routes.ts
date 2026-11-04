/** HTTP routes for connectors (internal/admin: all require `x-internal-token` when configured). */
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import type { EventEnvelope } from '../platform/event-bus.js';
import type { ConnectorService } from './service.js';
import { ConnectorTypeSchema } from './types.js';

const Params = z.object({ institutionId: z.string().uuid(), type: ConnectorTypeSchema });
const Limit = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

const SyncBody = z
  .object({
    dryRun: z.boolean().default(false),
    since: z.string().datetime({ offset: true }).optional(),
    full: z.boolean().default(false),
    triggeredBy: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((b) => !(b.full && b.since), { message: 'full and since are mutually exclusive' });

/** Raw envelope or Pub/Sub push `{ message: { data: base64(envelope) } }`. */
export function unwrapEnvelope(body: unknown): EventEnvelope {
  let value = body as Record<string, unknown> | null;
  const message = value?.['message'] as { data?: unknown } | undefined;
  if (message && typeof message.data === 'string') {
    try {
      value = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'invalid_push', 'message.data is not base64 JSON');
    }
  }
  const parsed = z
    .object({
      eventId: z.string().min(1),
      type: z.string().min(1),
      institutionId: z.string().uuid().nullable().optional(),
      data: z.record(z.unknown()),
    })
    .passthrough()
    .safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'invalid_event', 'Body is not an event envelope');
  return {
    eventId: parsed.data.eventId,
    type: parsed.data.type,
    version: 1,
    occurredAt: typeof value?.['occurredAt'] === 'string' ? value['occurredAt'] : new Date().toISOString(),
    source: typeof value?.['source'] === 'string' ? value['source'] : 'unknown',
    institutionId: parsed.data.institutionId ?? null,
    data: parsed.data.data,
  };
}

export function registerConnectorRoutes(
  app: FastifyInstance,
  service: ConnectorService,
  internal: { preHandler: preHandlerHookHandler },
): void {
  app.put('/v1/connectors/:institutionId/:type', internal, async (req, reply) => {
    const { institutionId, type } = Params.parse(req.params);
    const actor = typeof req.headers['x-actor-id'] === 'string' ? req.headers['x-actor-id'] : undefined;
    const { config, created } = await service.upsertConfig(institutionId, type, req.body, actor);
    return reply.status(created ? 201 : 200).send(config);
  });

  app.get('/v1/connectors/:institutionId', internal, async (req) => {
    const { institutionId } = z.object({ institutionId: z.string().uuid() }).parse(req.params);
    return { items: await service.listConfigs(institutionId) };
  });

  app.get('/v1/connectors/:institutionId/:type', internal, async (req) => {
    const { institutionId, type } = Params.parse(req.params);
    const config = await service.getConfig(institutionId, type);
    if (!config) throw new HttpError(404, 'connector_not_found', `No ${type} connector for institution ${institutionId}`);
    return config;
  });

  app.post('/v1/connectors/:institutionId/:type/sync', internal, async (req, reply) => {
    const { institutionId, type } = Params.parse(req.params);
    const body = SyncBody.parse(req.body ?? {});
    const { run, httpStatus } = await service.sync(institutionId, type, {
      dryRun: body.dryRun,
      full: body.full,
      ...(body.since ? { since: new Date(body.since) } : {}),
      ...(body.triggeredBy ? { triggeredBy: body.triggeredBy } : {}),
    });
    return reply.status(httpStatus).send(run);
  });

  app.get('/v1/connectors/:institutionId/:type/runs', internal, async (req) => {
    const { institutionId, type } = Params.parse(req.params);
    const { limit } = Limit.parse(req.query);
    return { items: await service.listRuns(institutionId, type, limit) };
  });

  app.get('/v1/connector-runs/:id', internal, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const run = await service.getRun(id);
    if (!run) throw new HttpError(404, 'run_not_found', `Connector run ${id} not found`);
    return run;
  });

  app.get('/v1/connectors/:institutionId/:type/publications', internal, async (req) => {
    const { institutionId, type } = Params.parse(req.params);
    const { limit } = Limit.parse(req.query);
    return { items: await service.listPublications(institutionId, type, limit) };
  });

  // Event push (dev bus / Pub/Sub): calendar.event_published and lecture.structured → LMS outbound.
  const push = async (body: unknown, expected: string): Promise<{ status: number; result: unknown }> => {
    const event = unwrapEnvelope(body);
    if (event.type !== expected) return { status: 200, result: { eventId: event.eventId, ignored: true } };
    const result = await service.handleEvent(event);
    return { status: result.failed > 0 ? 503 : 200, result };
  };
  app.post('/v1/events/calendar-event-published', internal, async (req, reply) => {
    const { status, result } = await push(req.body, 'calendar.event_published');
    return reply.status(status).send(result);
  });
  app.post('/v1/events/lecture-structured', internal, async (req, reply) => {
    const { status, result } = await push(req.body, 'lecture.structured');
    return reply.status(status).send(result);
  });
}
