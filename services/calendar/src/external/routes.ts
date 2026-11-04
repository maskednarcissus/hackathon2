import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { PROVIDERS } from './providers.js';
import { ExternalCalendarError, type ExternalCalendarService } from './sync.js';

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const StudentParams = z.object({ studentId: z.string().uuid() });
const ConnectParams = StudentParams.extend({ provider: z.enum(PROVIDERS) });
const ConnectionParams = StudentParams.extend({ connectionId: z.string().uuid() });
const ProviderParams = z.object({ provider: z.enum(PROVIDERS) });
const CallbackQuery = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(512),
  error: z.string().max(200).optional(),
});
const ReconcileBody = z.object({ studentId: z.string().uuid().optional() }).default({});

const EventSchema = z
  .object({
    id: z.string().uuid(),
    classSectionId: z.string().uuid(),
    version: z.number().int(),
    status: z.enum(['published', 'cancelled']),
  })
  .passthrough();
const EnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  type: z.string(),
  data: z.object({ event: EventSchema }).passthrough(),
});
const PushSchema = z.object({
  message: z.object({ data: z.string(), messageId: z.string().optional() }),
  subscription: z.string().optional(),
});

/** Accepts Pub/Sub push format or a raw envelope (integration stage §2). */
function parseEnvelope(body: unknown): z.infer<typeof EnvelopeSchema> {
  const push = PushSchema.safeParse(body);
  const raw: unknown = push.success
    ? JSON.parse(Buffer.from(push.data.message.data, 'base64').toString('utf8'))
    : body;
  return EnvelopeSchema.parse(raw);
}

const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ExternalCalendarError)
      throw new AppError(err.statusCode, err.code, err.message);
    throw err;
  }
};

export function registerExternalCalendarRoutes(
  app: FastifyInstance,
  opts: {
    service: ExternalCalendarService;
    studentAccess: Guard;
    internalOnly: (req: FastifyRequest) => Promise<void>;
    markProcessed: (eventId: string) => Promise<boolean>;
    unmarkProcessed: (eventId: string) => Promise<void>;
    returnUrl?: string | undefined;
  },
): void {
  const { service } = opts;

  app.get(
    '/v1/students/:studentId/calendar-connections',
    { preHandler: opts.studentAccess },
    async (req) => {
      const { studentId } = StudentParams.parse(req.params);
      return { items: await service.list(studentId) };
    },
  );

  app.post(
    '/v1/students/:studentId/calendar-connections/connect/:provider',
    { preHandler: opts.studentAccess },
    async (req, reply) => {
      const { studentId, provider } = ConnectParams.parse(req.params);
      const result = await wrap(() => service.connect(studentId, provider));
      return reply
        .status(201)
        .header('cache-control', 'no-store')
        .send({ provider, ...result });
    },
  );

  app.delete(
    '/v1/students/:studentId/calendar-connections/:connectionId',
    { preHandler: opts.studentAccess },
    async (req, reply) => {
      const { studentId, connectionId } = ConnectionParams.parse(req.params);
      const owned = (await service.list(studentId)).some((c) => c.id === connectionId);
      if (!owned) throw new AppError(404, 'not_found', 'Connection not found');
      const result = await wrap(() => service.disconnect(connectionId));
      return reply.status(200).send({ deleted: true, ...result });
    },
  );

  // The state (single use, bound to student + provider, 10 min) authenticates the callback.
  app.get('/v1/oauth/:provider/callback', async (req, reply) => {
    const { provider } = ProviderParams.parse(req.params);
    const query = CallbackQuery.parse(req.query);
    if (query.error !== undefined || query.code === undefined) {
      throw new AppError(
        400,
        'authorization_denied',
        `Provider returned: ${query.error ?? 'no code'}`,
      );
    }
    const code = query.code;
    const result = await wrap(() => service.callback(provider, code, query.state));
    if (opts.returnUrl) {
      const url = new URL(opts.returnUrl);
      url.searchParams.set('provider', provider);
      url.searchParams.set('status', result.connection.status);
      return reply.redirect(url.toString(), 302);
    }
    return result;
  });

  app.post('/internal/v1/events/calendar', { preHandler: opts.internalOnly }, async (req) => {
    const envelope = parseEnvelope(req.body);
    if (
      envelope.type !== 'calendar.event_published' &&
      envelope.type !== 'calendar.event_updated'
    ) {
      return { ignored: true, type: envelope.type };
    }
    if (!(await opts.markProcessed(envelope.eventId))) return { duplicate: true };
    try {
      const stats = await service.syncEvent(envelope.data.event as never);
      return { processed: true, ...stats };
    } catch (err) {
      await opts.unmarkProcessed(envelope.eventId); // let the bus redeliver
      throw err;
    }
  });

  app.post(
    '/internal/v1/external-calendars/reconcile',
    { preHandler: opts.internalOnly },
    async (req) => {
      const body = ReconcileBody.parse(req.body ?? {});
      return service.reconcile(body.studentId);
    },
  );
}
