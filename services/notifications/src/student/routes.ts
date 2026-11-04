import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, parse } from '../http.js';
import {
  extractBearerToken,
  type AccessTokenClaims,
  type AccessTokenVerifier,
} from '../vendor/jwt-verify.js';
import type { StudentNotifier } from './notifier.js';
import { applyUpdate, PreferencesError, PreferencesUpdateSchema } from './preferences.js';
import type { StudentStore } from './store.js';
import { fromB64url } from './webpush.js';

export interface StudentRouteDeps {
  store: StudentStore;
  notifier: StudentNotifier;
  clock: () => Date;
  vapidPublicKey: string | null;
  /** When set, user routes require `Authorization: Bearer` (identity JWT, EdDSA via JWKS). */
  verifyToken?: AccessTokenVerifier | undefined;
  /** When set, internal routes (sync, reminders, flush) require `x-internal-token`. */
  internalToken?: string | undefined;
}

const uuid = z.string().uuid();
const UserParams = z.object({ userId: z.string().min(1).max(100) });
const NotificationParams = UserParams.extend({ id: uuid });
const ListQuery = z.object({
  unread: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime({ offset: true }).optional(),
});
const NowBody = z.object({ now: z.string().datetime({ offset: true }).optional() }).default({});

const b64urlBytes = (len: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+=*$/, 'base64url expected')
    .refine((s) => {
      try {
        return fromB64url(s.replace(/=+$/, '')).length === len;
      } catch {
        return false;
      }
    }, `must decode to ${len} bytes`);

/** Same shape as `PushSubscription.toJSON()` in browsers. */
const PushSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(2000)
    .refine((u) => u.startsWith('https://'), 'push endpoint must be https'),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: b64urlBytes(65), auth: b64urlBytes(16) }),
  userAgent: z.string().max(500).optional(),
});

/** Same body as identity `POST /v1/sync/enrollments`, plus optional `userId` / `email` per row. */
const SyncEnrollmentsSchema = z.object({
  institutionId: uuid,
  mode: z.enum(['upsert', 'replace']).default('upsert'),
  enrollments: z
    .array(
      z.object({
        studentId: uuid,
        classSectionId: uuid,
        status: z.enum(['active', 'withdrawn', 'completed']).default('active'),
        /** identity user id (defaults to studentId) */
        userId: z.string().min(1).max(100).optional(),
        email: z.string().email().nullable().optional(),
      }),
    )
    .max(50_000),
});

export function registerStudentRoutes(app: FastifyInstance, deps: StudentRouteDeps): void {
  const { store, notifier, clock } = deps;

  const authorizeUser = async (req: FastifyRequest, userId: string): Promise<void> => {
    if (!deps.verifyToken) return;
    const token = extractBearerToken(req.headers.authorization);
    if (!token) throw new HttpError(401, 'unauthorized', 'Bearer token required');
    let claims: AccessTokenClaims;
    try {
      claims = await deps.verifyToken(token);
    } catch {
      throw new HttpError(401, 'invalid_token', 'Invalid or expired access token');
    }
    if (claims.sub !== userId)
      throw new HttpError(403, 'forbidden', 'Users can only access their own notifications');
  };

  const authorizeInternal = (req: FastifyRequest): void => {
    if (!deps.internalToken) return;
    const given = Buffer.from(String(req.headers['x-internal-token'] ?? ''));
    const expected = Buffer.from(deps.internalToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new HttpError(401, 'unauthorized', 'Internal token required');
    }
  };

  // ---------------------------------------------------------------- in-app inbox
  app.get('/v1/users/:userId/notifications', async (req) => {
    const { userId } = parse(UserParams, req.params);
    await authorizeUser(req, userId);
    const q = parse(ListQuery, req.query);
    const items = await store.listNotifications(userId, {
      limit: q.limit,
      ...(q.unread !== undefined ? { unread: q.unread } : {}),
      ...(q.before ? { before: q.before } : {}),
    });
    return {
      items: items.map(({ dedupeKey: _d, inApp: _i, ...rest }) => rest),
      unreadCount: await store.countUnread(userId),
      nextBefore: items.length === q.limit ? (items.at(-1)?.createdAt ?? null) : null,
    };
  });

  app.post('/v1/users/:userId/notifications/:id/read', async (req) => {
    const { userId, id } = parse(NotificationParams, req.params);
    await authorizeUser(req, userId);
    const n = await store.markRead(userId, id, clock().toISOString());
    if (!n) throw new HttpError(404, 'not_found', 'Notification not found');
    return { id: n.id, readAt: n.readAt, unreadCount: await store.countUnread(userId) };
  });

  app.post('/v1/users/:userId/notifications/read-all', async (req) => {
    const { userId } = parse(UserParams, req.params);
    await authorizeUser(req, userId);
    const updated = await store.markAllRead(userId, clock().toISOString());
    return { updated, unreadCount: 0 };
  });

  // ---------------------------------------------------------------- preferences
  app.get('/v1/users/:userId/notification-preferences', async (req) => {
    const { userId } = parse(UserParams, req.params);
    await authorizeUser(req, userId);
    return notifier.preferencesOf(userId);
  });

  app.put('/v1/users/:userId/notification-preferences', async (req) => {
    const { userId } = parse(UserParams, req.params);
    await authorizeUser(req, userId);
    const update = parse(PreferencesUpdateSchema, req.body);
    try {
      const next = applyUpdate(await notifier.preferencesOf(userId), update, clock());
      await store.savePreferences(next);
      return next;
    } catch (err) {
      if (err instanceof PreferencesError)
        throw new HttpError(422, err.code, err.message, err.details);
      throw err;
    }
  });

  // ---------------------------------------------------------------- push subscriptions
  app.get('/v1/push/vapid-public-key', () => {
    if (!deps.vapidPublicKey)
      throw new HttpError(503, 'push_not_configured', 'Web Push is not configured');
    return { publicKey: deps.vapidPublicKey };
  });

  app.post('/v1/users/:userId/push-subscriptions', async (req, reply) => {
    const { userId } = parse(UserParams, req.params);
    await authorizeUser(req, userId);
    const body = parse(PushSubscriptionSchema, req.body);
    const saved = await store.upsertPushSubscription({
      id: randomUUID(),
      userId,
      endpoint: body.endpoint,
      keys: {
        p256dh: body.keys.p256dh.replace(/=+$/, ''),
        auth: body.keys.auth.replace(/=+$/, ''),
      },
      userAgent:
        body.userAgent ?? (req.headers['user-agent'] ? String(req.headers['user-agent']) : null),
      createdAt: clock().toISOString(),
      lastSuccessAt: null,
      failureCount: 0,
    });
    return reply
      .status(201)
      .send({ id: saved.id, endpoint: saved.endpoint, createdAt: saved.createdAt });
  });

  app.get('/v1/users/:userId/push-subscriptions', async (req) => {
    const { userId } = parse(UserParams, req.params);
    await authorizeUser(req, userId);
    const subs = await store.listPushSubscriptions(userId);
    return {
      items: subs.map((s) => ({
        id: s.id,
        endpoint: s.endpoint,
        userAgent: s.userAgent,
        createdAt: s.createdAt,
        lastSuccessAt: s.lastSuccessAt,
      })),
    };
  });

  app.delete('/v1/users/:userId/push-subscriptions/:id', async (req, reply) => {
    const { userId, id } = parse(NotificationParams, req.params);
    await authorizeUser(req, userId);
    if (!(await store.deletePushSubscription(userId, id))) {
      throw new HttpError(404, 'not_found', 'Push subscription not found');
    }
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- internal
  app.post('/v1/sync/enrollments', async (req) => {
    authorizeInternal(req);
    const body = parse(SyncEnrollmentsSchema, req.body);
    const now = clock().toISOString();
    const seen = new Set<string>();
    for (const e of body.enrollments) {
      const userId = e.userId ?? e.studentId;
      await store.upsertEnrollment({
        userId,
        studentId: e.studentId,
        institutionId: body.institutionId,
        classSectionId: e.classSectionId,
        email: e.email ?? null,
        status: e.status,
        syncedAt: now,
      });
      seen.add(`${userId}|${e.classSectionId}`);
    }
    let withdrawn = 0;
    if (body.mode === 'replace') {
      for (const sectionId of new Set(body.enrollments.map((e) => e.classSectionId))) {
        for (const existing of await store.listEnrollments(sectionId)) {
          if (
            existing.institutionId === body.institutionId &&
            existing.status === 'active' &&
            !seen.has(`${existing.userId}|${existing.classSectionId}`)
          ) {
            await store.upsertEnrollment({ ...existing, status: 'withdrawn', syncedAt: now });
            withdrawn += 1;
          }
        }
      }
    }
    return { upserted: body.enrollments.length, withdrawn };
  });

  app.post('/v1/reminders/run', async (req) => {
    authorizeInternal(req);
    const body = parse(NowBody, req.body ?? {});
    return notifier.runReminders(body.now ? new Date(body.now) : clock());
  });

  app.post('/v1/notifications/flush-deferred', async (req) => {
    authorizeInternal(req);
    const body = parse(NowBody, req.body ?? {});
    const flushed = await notifier.flushDeferred(body.now ? new Date(body.now) : clock());
    return { flushed, remaining: await store.countDeferred() };
  });

  app.get('/v1/notifications/:id/deliveries', async (req) => {
    authorizeInternal(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const n = await store.getNotification(id);
    if (!n) throw new HttpError(404, 'not_found', 'Notification not found');
    return { notification: n, deliveries: await store.deliveries(id) };
  });
}
