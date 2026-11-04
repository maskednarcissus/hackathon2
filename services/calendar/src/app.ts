import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import { z } from 'zod';
import { InMemoryEventPublisher, type EventPublisher } from './events.js';
import { extractBearerToken, JwtError, type AccessTokenVerifier } from './jwt-verify.js';
import { InMemoryAuditClient, type AuditClient } from './audit.js';
import { detectConflicts } from './conflicts.js';
import { byChangeOrder, toStudentVisible, type SectionRecord } from './domain.js';
import {
  InMemoryFeedTokenRepository,
  generateFeedToken,
  verifyFeedToken,
  type FeedTokenRepository,
} from './feed-tokens.js';
import { renderIcs } from './ics.js';
import { AppError, notFound, registerErrorHandler } from './errors.js';
import { InMemoryCalendarRepository, type CalendarRepository } from './repository.js';
import {
  CancelEventSchema,
  ConflictCheckSchema,
  CreateCalendarEventSchema,
  EnrollmentsBulkSchema,
  FeedQuerySchema,
  HistoryQuerySchema,
  IdParamSchema,
  InstitutionQuerySchema,
  ListEventsQuerySchema,
  NonTeachingDaysSchema,
  SectionsSyncSchema,
  StudentEventsQuerySchema,
  StudentParamSchema,
  TermSchema,
} from './schemas.js';
import { CalendarService, systemClock, type Clock } from './service.js';

export interface AppDeps {
  repository?: CalendarRepository;
  audit?: AuditClient;
  clock?: Clock;
  feedTokens?: FeedTokenRepository;
  /** Event bus publisher (integration stage §2); defaults to in-memory. */
  events?: EventPublisher;
  /**
   * INTERNAL_API_TOKEN (§4): when set, required as `x-internal-token` on /internal/* and sync endpoints.
   * Unset → open (dev only).
   */
  internalToken?: string;
  /**
   * Identity access-token verifier (vendored jwt-verify, JWKS). When set, student routes require a bearer
   * token whose `pid` is the student (or a coordinator/admin of the student's institution).
   */
  verifyAccessToken?: AccessTokenVerifier;
  logger?: FastifyServerOptions['logger'];
}

const DsrParamsSchema = z.object({
  type: z.enum(['access', 'correction', 'deletion', 'anonymization', 'restriction']),
});
const DsrBodySchema = z.object({
  subjectType: z.enum(['student', 'professor', 'user']),
  subjectId: z.string().uuid(),
  requestId: z.string().uuid(),
  institutionId: z.string().uuid(),
  details: z.record(z.unknown()).optional(),
});

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Feed tokens travel in the query string; never write them to logs. */
export const redactTokens = (url: string): string =>
  url.replace(/([?&]token=)[^&]*/g, '$1[REDACTED]');

type LoggerOption = NonNullable<FastifyServerOptions['logger']>;

function withRedaction(logger: FastifyServerOptions['logger']): LoggerOption {
  if (logger === undefined || logger === false) return false;
  const base = logger === true ? {} : logger;
  return {
    ...base,
    serializers: {
      req: (req: { method: string; url: string }): Record<string, string> => ({
        method: req.method,
        url: redactTokens(req.url),
      }),
    },
  };
}

export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const repo = deps.repository ?? new InMemoryCalendarRepository();
  const audit = deps.audit ?? new InMemoryAuditClient();
  const clock = deps.clock ?? systemClock;
  const service = new CalendarService(
    repo,
    audit,
    clock,
    deps.events ?? new InMemoryEventPublisher(),
  );
  const feedTokens = deps.feedTokens ?? new InMemoryFeedTokenRepository();

  const app = Fastify({ logger: withRedaction(deps.logger) });
  registerErrorHandler(app);
  app.decorateRequest('auth', undefined);

  /** §4: constant-time check of x-internal-token; open when no token is configured (dev). */
  const internalOnly = async (req: FastifyRequest): Promise<void> => {
    const expected = deps.internalToken;
    if (!expected) return;
    const provided = req.headers['x-internal-token'];
    if (typeof provided !== 'string' || !timingSafeEqual(digest(provided), digest(expected))) {
      throw new AppError(401, 'unauthorized', 'Valid x-internal-token required');
    }
  };

  /** §4: student routes — the token's pid must be the student, unless staff of the student's institution. */
  const studentAccess = async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const verify = deps.verifyAccessToken;
    if (!verify) return;
    const token = extractBearerToken(req.headers.authorization);
    if (!token) throw new AppError(401, 'unauthorized', 'Bearer token required');
    let claims;
    try {
      claims = await verify(token);
    } catch (err) {
      const code =
        err instanceof JwtError && err.code === 'expired' ? 'token_expired' : 'invalid_token';
      throw new AppError(401, code, 'Invalid or expired access token');
    }
    req.auth = claims;
    const { studentId } = StudentParamSchema.parse(req.params);
    if (claims.role === 'student') {
      if (claims.pid !== studentId)
        throw new AppError(403, 'forbidden', 'Students can only access their own calendar');
      return;
    }
    if (claims.role === 'coordinator' || claims.role === 'admin') {
      for (const sectionId of await repo.sectionsOfStudent(studentId)) {
        const section = await repo.getSection(sectionId);
        if (section && section.institutionId !== claims.inst) {
          throw new AppError(403, 'cross_institution', 'Cross-institution access denied');
        }
      }
      return;
    }
    throw new AppError(403, 'forbidden', 'Role not permitted for student calendars');
  };

  app.get('/health', async () => ({ status: 'ok', service: 'calendar' }));

  // ---- Calendar events ----------------------------------------------------
  app.post('/v1/calendar-events', async (req, reply) => {
    const input = CreateCalendarEventSchema.parse(req.body);
    const result = await service.publish(input);
    return reply.status(result.created ? 201 : 200).send({
      event: result.event,
      created: result.created,
      changes: result.changes,
      conflicts: result.conflicts,
    });
  });

  app.get('/v1/calendar-events', async (req) => {
    const q = ListEventsQuerySchema.parse(req.query);
    const events = await repo.listEvents({
      ...(q.institutionId !== undefined ? { institutionId: q.institutionId } : {}),
      ...(q.courseId !== undefined ? { courseId: q.courseId } : {}),
      ...(q.classSectionId !== undefined ? { classSectionId: q.classSectionId } : {}),
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
      ...(q.includeCancelled !== undefined ? { includeCancelled: q.includeCancelled } : {}),
    });
    return { items: events, total: events.length };
  });

  app.get('/v1/calendar-events/:id', async (req) => {
    const { id } = IdParamSchema.parse(req.params);
    const event = await repo.getEvent(id);
    if (!event) throw notFound('Calendar event', id);
    const history = await repo.listChanges(id);
    return { ...event, history };
  });

  app.get('/v1/calendar-events/:id/history', async (req) => {
    const { id } = IdParamSchema.parse(req.params);
    const { view } = HistoryQuerySchema.parse(req.query);
    if (!(await repo.getEvent(id))) throw notFound('Calendar event', id);
    const changes = (await repo.listChanges(id)).sort(byChangeOrder);
    return { items: view === 'student' ? changes.map(toStudentVisible) : changes };
  });

  app.post('/v1/calendar-events/:id/cancel', async (req) => {
    const { id } = IdParamSchema.parse(req.params);
    const body = CancelEventSchema.parse(req.body);
    return service.cancel(id, body.actorId, body.reason, body.source);
  });

  // ---- Conflicts ------------------------------------------------------------
  app.post('/v1/conflicts/check', async (req) => {
    const q = ConflictCheckSchema.parse(req.body);
    const conflicts = await detectConflicts(repo, q);
    return {
      conflicts,
      hasBlocking: conflicts.some((c) => c.severity === 'blocking'),
    };
  });

  // ---- Reference data sync -------------------------------------------------
  app.post('/v1/sections', { preHandler: internalOnly }, async (req) => {
    const { sections } = SectionsSyncSchema.parse(req.body);
    for (const s of sections) {
      await repo.upsertSection({
        classSectionId: s.classSectionId,
        institutionId: s.institutionId,
        courseId: s.courseId,
        professorId: s.professorId ?? null,
        courseName: s.courseName ?? null,
        sectionCode: s.sectionCode ?? null,
      });
    }
    return { upserted: sections.length };
  });

  app.post('/v1/enrollments/bulk', { preHandler: internalOnly }, async (req) => {
    const body = EnrollmentsBulkSchema.parse(req.body);
    if (!(await repo.getSection(body.classSectionId))) {
      throw notFound('Class section', body.classSectionId);
    }
    const unique = [...new Set(body.studentIds)];
    if (body.mode === 'replace') await repo.replaceEnrollments(body.classSectionId, unique);
    else await repo.addEnrollments(body.classSectionId, unique);
    const total = (await repo.studentsOf(body.classSectionId)).size;
    return { classSectionId: body.classSectionId, mode: body.mode, enrolled: total };
  });

  app.post('/v1/non-teaching-days', { preHandler: internalOnly }, async (req) => {
    const body = NonTeachingDaysSchema.parse(req.body);
    await repo.upsertNonTeachingDays(
      body.days.map((d) => ({ institutionId: body.institutionId, ...d })),
    );
    return { upserted: body.days.length };
  });

  app.get('/v1/non-teaching-days', async (req) => {
    const { institutionId } = InstitutionQuerySchema.parse(req.query);
    return { items: await repo.listNonTeachingDays(institutionId) };
  });

  app.post('/v1/terms', { preHandler: internalOnly }, async (req, reply) => {
    const t = TermSchema.parse(req.body);
    const term = {
      id: t.id ?? randomUUID(),
      institutionId: t.institutionId,
      name: t.name ?? null,
      startDate: t.startDate,
      endDate: t.endDate,
    };
    await repo.upsertTerm(term);
    return reply.status(201).send(term);
  });

  app.get('/v1/terms', async (req) => {
    const { institutionId } = InstitutionQuerySchema.parse(req.query);
    return { items: await repo.listTerms(institutionId) };
  });

  // ---- Student fan-out (Phase 3 groundwork) --------------------------------
  const studentEvents = async (
    studentId: string,
    q: {
      from?: string | undefined;
      to?: string | undefined;
      includeCancelled?: boolean | undefined;
    },
  ): Promise<Awaited<ReturnType<CalendarRepository['listEvents']>>> => {
    const sectionIds = await repo.sectionsOfStudent(studentId);
    if (sectionIds.length === 0) return [];
    return repo.listEvents({
      classSectionIds: sectionIds,
      includeCancelled: q.includeCancelled ?? true,
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
    });
  };

  // ---- Student view (3.8, 3.9) ----------------------------------------------
  app.get('/v1/students/:studentId/calendar-events', { preHandler: studentAccess }, async (req) => {
    const { studentId } = StudentParamSchema.parse(req.params);
    const q = StudentEventsQuerySchema.parse(req.query);
    const events = await studentEvents(studentId, q);
    const items = await Promise.all(
      events.map(async (e) => {
        const { provenance, ...rest } = e;
        const history = (await repo.listChanges(e.id)).sort(byChangeOrder).map(toStudentVisible);
        const section = await repo.getSection(e.classSectionId);
        return {
          ...rest,
          courseName: section?.courseName ?? null,
          source: provenance
            ? {
                recordingSessionId: provenance.recordingSessionId,
                transcriptId: provenance.transcriptId,
                ...(provenance.scheduledClassId !== undefined
                  ? { scheduledClassId: provenance.scheduledClassId }
                  : {}),
                segmentIndex: provenance.segmentIndex,
                startMs: provenance.startMs,
                endMs: provenance.endMs,
                quote: provenance.quote,
                confirmedAt: provenance.confirmedAt,
              }
            : null,
          history,
        };
      }),
    );
    return { studentId, items, total: items.length };
  });

  // ---- ICS export (3.10) ------------------------------------------------------
  app.post(
    '/v1/students/:studentId/calendar-feed-token',
    { preHandler: studentAccess },
    async (req, reply) => {
      const { studentId } = StudentParamSchema.parse(req.params);
      const previous = await feedTokens.get(studentId);
      const { token, tokenHash } = generateFeedToken();
      const createdAt = clock.now().toISOString();
      await feedTokens.put({ studentId, tokenHash, createdAt });
      return reply
        .status(201)
        .header('cache-control', 'no-store')
        .send({
          studentId,
          token,
          feedPath: `/v1/students/${studentId}/calendar.ics?token=${token}`,
          createdAt,
          rotated: previous !== undefined,
        });
    },
  );

  app.get('/v1/students/:studentId/calendar.ics', async (req, reply) => {
    const { studentId } = StudentParamSchema.parse(req.params);
    const { token, from } = FeedQuerySchema.parse(req.query);
    const record = await feedTokens.get(studentId);
    // Same answer for unknown student, missing token and wrong token (no enumeration).
    if (token === undefined || record === undefined || !verifyFeedToken(token, record.tokenHash)) {
      throw new AppError(401, 'invalid_feed_token', 'Invalid or revoked calendar feed token');
    }
    const events = await studentEvents(studentId, { from, includeCancelled: true });
    const sections = new Map<string, SectionRecord>();
    for (const id of new Set(events.map((e) => e.classSectionId))) {
      const s = await repo.getSection(id);
      if (s) sections.set(id, s);
    }
    const body = renderIcs(events, {
      calendarName: 'Calendário acadêmico',
      generatedAt: clock.now(),
      sections,
    });
    return reply
      .header('content-type', 'text/calendar; charset=utf-8')
      .header('content-disposition', 'inline; filename="calendario-academico.ics"')
      .header('cache-control', 'private, max-age=300')
      .send(body);
  });

  // ---- LGPD data subject rights (Phase 4 §6; integration §5: calendar owns the feed token) -----
  app.post('/internal/v1/dsr/:type', { preHandler: internalOnly }, async (req) => {
    const { type } = DsrParamsSchema.parse(req.params);
    const body = DsrBodySchema.parse(req.body);
    // Calendar holds personal data keyed by studentId only (the ICS feed token).
    if (body.subjectType !== 'student') {
      return {
        service: 'calendar',
        status: 'not_applicable',
        items: { reason: 'no_student_data' },
      };
    }
    if (type === 'deletion' || type === 'anonymization' || type === 'restriction') {
      const removed = await feedTokens.delete(body.subjectId);
      req.log.info(
        { requestId: body.requestId, type, removed },
        'dsr: calendar feed token processed',
      );
      return {
        service: 'calendar',
        status: 'completed',
        items: { feedTokensRemoved: removed ? 1 : 0 },
      };
    }
    if (type === 'access') {
      const record = await feedTokens.get(body.subjectId);
      return {
        service: 'calendar',
        status: 'completed',
        items: {
          calendarFeed: record ? { active: true, createdAt: record.createdAt } : { active: false },
        },
      };
    }
    return {
      service: 'calendar',
      status: 'not_applicable',
      items: { reason: 'nothing_to_correct' },
    };
  });

  return app;
}
