import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
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
  logger?: FastifyServerOptions['logger'];
}

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
  const service = new CalendarService(repo, audit, clock);
  const feedTokens = deps.feedTokens ?? new InMemoryFeedTokenRepository();

  const app = Fastify({ logger: withRedaction(deps.logger) });
  registerErrorHandler(app);

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
  app.post('/v1/sections', async (req) => {
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

  app.post('/v1/enrollments/bulk', async (req) => {
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

  app.post('/v1/non-teaching-days', async (req) => {
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

  app.post('/v1/terms', async (req, reply) => {
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
  app.get('/v1/students/:studentId/calendar-events', async (req) => {
    const { studentId } = StudentParamSchema.parse(req.params);
    const q = StudentEventsQuerySchema.parse(req.query);
    const events = await studentEvents(studentId, q);
    const items = await Promise.all(
      events.map(async (e) => {
        const { provenance, ...rest } = e;
        const history = (await repo.listChanges(e.id)).sort(byChangeOrder).map(toStudentVisible);
        return {
          ...rest,
          source: provenance
            ? {
                recordingSessionId: provenance.recordingSessionId,
                transcriptId: provenance.transcriptId,
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
  app.post('/v1/students/:studentId/calendar-feed-token', async (req, reply) => {
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
  });

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

  return app;
}
