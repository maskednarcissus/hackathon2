import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { InMemoryAuditClient, type AuditClient } from './audit.js';
import { detectConflicts } from './conflicts.js';
import { notFound, registerErrorHandler } from './errors.js';
import { InMemoryCalendarRepository, type CalendarRepository } from './repository.js';
import {
  CancelEventSchema,
  ConflictCheckSchema,
  CreateCalendarEventSchema,
  EnrollmentsBulkSchema,
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
  logger?: FastifyServerOptions['logger'];
}

export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const repo = deps.repository ?? new InMemoryCalendarRepository();
  const audit = deps.audit ?? new InMemoryAuditClient();
  const service = new CalendarService(repo, audit, deps.clock ?? systemClock);

  const app = Fastify({ logger: deps.logger ?? false });
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
    if (!(await repo.getEvent(id))) throw notFound('Calendar event', id);
    return { items: await repo.listChanges(id) };
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
  app.get('/v1/students/:studentId/calendar-events', async (req) => {
    const { studentId } = StudentParamSchema.parse(req.params);
    const q = StudentEventsQuerySchema.parse(req.query);
    const sectionIds = await repo.sectionsOfStudent(studentId);
    const events =
      sectionIds.length === 0
        ? []
        : await repo.listEvents({
            classSectionIds: sectionIds,
            ...(q.from !== undefined ? { from: q.from } : {}),
            ...(q.to !== undefined ? { to: q.to } : {}),
            ...(q.includeCancelled !== undefined ? { includeCancelled: q.includeCancelled } : {}),
          });
    return { studentId, items: events, total: events.length };
  });

  return app;
}
