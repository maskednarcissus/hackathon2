import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { InMemoryAuditClient, type AuditClient } from './audit.js';
import { InMemoryChannel, RecipientDirectory, type NotificationChannel } from './channels.js';
import { AlertEngine } from './engine.js';
import {
  AlertActionSchema,
  AlertQuerySchema,
  EvaluateRequestSchema,
  EventEnvelopeSchema,
} from './schemas.js';
import { InMemoryAlertStore, type AlertStore } from './store.js';

export interface AppDeps {
  store?: AlertStore;
  channels?: NotificationChannel[];
  recipients?: RecipientDirectory;
  audit?: AuditClient;
  clock?: () => Date;
  logger?: boolean;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, 'validation_error', 'Invalid request', result.error.flatten());
  }
  return result.data as z.infer<S>;
}

const sendError = (reply: FastifyReply, err: HttpError): FastifyReply =>
  reply.status(err.statusCode).send({
    error: {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  });

export function buildApp(deps: AppDeps = {}): { app: FastifyInstance; engine: AlertEngine } {
  const app = Fastify({ logger: deps.logger ?? false });
  const store = deps.store ?? new InMemoryAlertStore();
  const engine = new AlertEngine({
    store,
    channels: deps.channels ?? [new InMemoryChannel()],
    recipients: deps.recipients ?? new RecipientDirectory(),
    audit: deps.audit ?? new InMemoryAuditClient(),
    clock: deps.clock ?? (() => new Date()),
    logger: app.log,
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return sendError(reply, err);
    if (err instanceof ZodError) {
      return sendError(
        reply,
        new HttpError(400, 'validation_error', 'Invalid request', err.flatten()),
      );
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return sendError(reply, new HttpError(status, 'bad_request', (err as Error).message));
    }
    app.log.error(err);
    return sendError(reply, new HttpError(500, 'internal_error', 'Internal server error'));
  });
  app.setNotFoundHandler((req, reply) =>
    sendError(reply, new HttpError(404, 'not_found', `Route ${req.method} ${req.url} not found`)),
  );

  app.get('/health', () => ({ status: 'ok', service: 'notifications' }));

  app.post('/v1/lifecycle-events', async (req, reply) => {
    const event = parse(EventEnvelopeSchema, req.body);
    const result = await engine.handleEvent(event);
    return reply.status(202).send({
      eventId: event.eventId,
      raised: result.raised.map((a) => a.id),
      updated: result.updated.map((a) => a.id),
      resolved: result.resolved.map((a) => a.id),
    });
  });

  app.post('/v1/alerts/evaluate', async (req) => {
    const input = parse(EvaluateRequestSchema, req.body ?? {});
    const result = await engine.evaluate(input);
    return {
      raised: result.raised,
      updated: result.updated,
      resolved: result.resolved,
    };
  });

  app.get('/v1/alerts', async (req) => {
    const query = parse(AlertQuerySchema, req.query);
    const alerts = await store.list(query);
    return { alerts, count: alerts.length };
  });

  app.get<{ Params: { id: string } }>('/v1/alerts/:id', async (req) => {
    const alert = await store.get(req.params.id);
    if (!alert) throw new HttpError(404, 'not_found', 'Alert not found');
    return { alert, deliveries: await store.deliveries(alert.id) };
  });

  app.post<{ Params: { id: string } }>('/v1/alerts/:id/acknowledge', async (req) => {
    const body = parse(AlertActionSchema, req.body);
    const alert = await engine.acknowledge(req.params.id, body.actorId, body.note);
    if (!alert) throw new HttpError(404, 'not_found', 'Alert not found');
    return { alert };
  });

  app.post<{ Params: { id: string } }>('/v1/alerts/:id/resolve', async (req) => {
    const body = parse(AlertActionSchema, req.body);
    const alert = await engine.resolve(req.params.id, body.actorId, body.note);
    if (!alert) throw new HttpError(404, 'not_found', 'Alert not found');
    return { alert };
  });

  return { app, engine };
}
