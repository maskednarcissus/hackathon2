import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { InMemoryAuditClient, type AuditClient } from './audit.js';
import { InMemoryChannel, RecipientDirectory, type NotificationChannel } from './channels.js';
import { AlertEngine } from './engine.js';
import { HttpError, parse, sendError } from './http.js';
import {
  AlertActionSchema,
  AlertQuerySchema,
  EvaluateRequestSchema,
  EventEnvelopeSchema,
} from './schemas.js';
import { InMemoryAlertStore, type AlertStore } from './store.js';
import {
  LocalEnrollmentDirectory,
  MapCalendarEventSource,
  MapClassDirectory,
  type CalendarEventSource,
  type ClassDirectory,
  type EnrollmentDirectory,
} from './student/directories.js';
import { InMemoryEmailSender, type EmailSender } from './student/email.js';
import { StudentNotifier } from './student/notifier.js';
import { registerStudentRoutes } from './student/routes.js';
import { InMemoryStudentStore, type StudentStore } from './student/store.js';
import { FakePushSender, type PushSender } from './student/webpush.js';
import type { AccessTokenVerifier } from './vendor/jwt-verify.js';

export interface AppDeps {
  // Phase 1 — recording failure alerts (1.17)
  store?: AlertStore;
  channels?: NotificationChannel[];
  recipients?: RecipientDirectory;
  audit?: AuditClient;
  clock?: () => Date;
  logger?: boolean;
  // Phase 3 — student notifications (3.11, 3.12)
  studentStore?: StudentStore;
  enrollments?: EnrollmentDirectory;
  calendar?: CalendarEventSource;
  classes?: ClassDirectory;
  email?: EmailSender;
  push?: PushSender;
  vapidPublicKey?: string | null;
  verifyToken?: AccessTokenVerifier;
  internalToken?: string;
  studentWebUrl?: string;
}

export function buildApp(deps: AppDeps = {}): {
  app: FastifyInstance;
  engine: AlertEngine;
  notifier: StudentNotifier;
} {
  const app = Fastify({ logger: deps.logger ?? false });
  const clock = deps.clock ?? ((): Date => new Date());
  const store = deps.store ?? new InMemoryAlertStore();
  const engine = new AlertEngine({
    store,
    channels: deps.channels ?? [new InMemoryChannel()],
    recipients: deps.recipients ?? new RecipientDirectory(),
    audit: deps.audit ?? new InMemoryAuditClient(),
    clock,
    logger: app.log,
  });
  const studentStore = deps.studentStore ?? new InMemoryStudentStore();
  const notifier = new StudentNotifier({
    store: studentStore,
    enrollments: deps.enrollments ?? new LocalEnrollmentDirectory(studentStore),
    calendar: deps.calendar ?? new MapCalendarEventSource(),
    classes: deps.classes ?? new MapClassDirectory(),
    email: deps.email ?? new InMemoryEmailSender(),
    push: deps.push ?? new FakePushSender(),
    clock,
    logger: app.log,
    ...(deps.studentWebUrl ? { studentWebUrl: deps.studentWebUrl } : {}),
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

  /**
   * Pub/Sub push target for every lifecycle event. Both consumers are idempotent
   * (alert dedupe key; student dedupe key), so a 503 here is safe to retry.
   */
  app.post('/v1/lifecycle-events', async (req, reply) => {
    const event = parse(EventEnvelopeSchema, req.body);
    const result = await engine.handleEvent(event);
    let students: Awaited<ReturnType<StudentNotifier['handleEvent']>>;
    try {
      students = await notifier.handleEvent(event);
    } catch (err) {
      app.log.error({ err, eventId: event.eventId, type: event.type }, 'student fan-out failed');
      throw new HttpError(
        503,
        'dependency_unavailable',
        'Student notification fan-out failed; retry',
      );
    }
    return reply.status(202).send({
      eventId: event.eventId,
      raised: result.raised.map((a) => a.id),
      updated: result.updated.map((a) => a.id),
      resolved: result.resolved.map((a) => a.id),
      studentNotifications: students,
    });
  });

  app.post('/v1/alerts/evaluate', async (req) => {
    const input = parse(EvaluateRequestSchema, req.body ?? {});
    const result = await engine.evaluate(input);
    return { raised: result.raised, updated: result.updated, resolved: result.resolved };
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

  registerStudentRoutes(app, {
    store: studentStore,
    notifier,
    clock,
    vapidPublicKey: deps.vapidPublicKey ?? null,
    verifyToken: deps.verifyToken,
    internalToken: deps.internalToken,
  });

  return { app, engine, notifier };
}
