import { timingSafeEqual } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { EventBus } from './bus.js';

export interface AppDeps {
  bus: EventBus;
  internalToken?: string | undefined;
  /** Accept topics missing from subscriptions.yaml (published to nobody). Default false. */
  allowUnknownTopics?: boolean;
  /** Await deliveries before answering publish calls unless `?wait=false`. Default false. */
  syncDelivery?: boolean;
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

const EnvelopeSchema = z
  .object({
    eventId: z.string().min(1).max(200),
    type: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
    occurredAt: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const PublishQuery = z.object({ wait: z.enum(['true', 'false']).optional() });

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 10 * 1024 * 1024 });
  const { bus } = deps;

  const authorize = (req: FastifyRequest): void => {
    if (!deps.internalToken) return;
    const given = Buffer.from(String(req.headers['x-internal-token'] ?? ''));
    const expected = Buffer.from(deps.internalToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new HttpError(401, 'unauthorized', 'Missing or invalid x-internal-token');
    }
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      });
    }
    if (err instanceof z.ZodError) {
      return reply
        .status(400)
        .send({ error: { code: 'validation_error', message: 'Invalid request', details: err.issues } });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : 'Unexpected error';
    return reply.status(status).send({
      error: { code: status === 500 ? 'internal_error' : 'bad_request', message },
    });
  });

  app.get('/health', () => ({ status: 'ok', service: 'dev-event-bus' }));

  app.get('/v1/topics', (req) => {
    authorize(req);
    return { items: bus.topics() };
  });

  // Pub/Sub-style verb suffix: POST /v1/topics/recording.uploaded:publish
  app.post('/v1/topics/*', async (req, reply) => {
    authorize(req);
    const rest = (req.params as Record<string, string | undefined>)['*'] ?? '';
    const match = /^([^/:]+):publish$/.exec(rest);
    if (!match?.[1]) throw new HttpError(404, 'not_found', 'Use POST /v1/topics/{topic}:publish');
    const topic = match[1];
    const query = PublishQuery.parse(req.query);
    const envelope = EnvelopeSchema.parse(req.body);
    if (envelope.type !== topic) {
      throw new HttpError(400, 'topic_mismatch', `Envelope type "${envelope.type}" ≠ topic "${topic}"`);
    }
    if (!bus.hasTopic(topic) && !deps.allowUnknownTopics) {
      throw new HttpError(404, 'unknown_topic', `Topic "${topic}" is not in subscriptions.yaml`);
    }
    const wait = query.wait === undefined ? (deps.syncDelivery ?? false) : query.wait === 'true';
    const result = await bus.publish(topic, envelope, wait);
    return reply.status(wait ? 200 : 202).send(result);
  });

  app.get('/v1/deliveries', (req) => {
    authorize(req);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(1000).default(100) })
      .parse(req.query);
    return { items: bus.recentDeliveries(limit) };
  });

  app.get('/v1/dead-letters', (req) => {
    authorize(req);
    const items = bus.listDeadLetters();
    return { items, total: items.length };
  });

  app.delete('/v1/dead-letters', (req) => {
    authorize(req);
    return { cleared: bus.clearDeadLetters() };
  });

  app.post('/v1/dead-letters/:deliveryId/replay', async (req) => {
    authorize(req);
    const { deliveryId } = z.object({ deliveryId: z.string().uuid() }).parse(req.params);
    const record = await bus.replay(deliveryId);
    if (!record) throw new HttpError(404, 'not_found', 'Dead letter not found');
    return record;
  });

  return app;
}
