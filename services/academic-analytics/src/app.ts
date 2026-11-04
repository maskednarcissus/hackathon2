import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adoption } from './adoption.js';
import { assessmentCalendar, detectConflicts, loadAssessments } from './assessments.js';
import { actorIdOf, Authenticator, type AuthConfig } from './auth.js';
import { UpstreamError } from './clients.js';
import { computeCoverage, type LectureForCoverage } from './coverage.js';
import {
  ClassroomSyncSchema,
  EnrollmentSyncSchema,
  SectionSyncSchema,
  type Directory,
} from './directory.js';
import { FakeEmbeddingClient, type EmbeddingClient } from './embeddings.js';
import { HttpError, installErrorHandler } from './errors.js';
import { FactSource } from './fact-source.js';
import type { UpstreamClients } from './fakes.js';
import { learningPatterns, loadInputs } from './learning-patterns.js';
import { buildReport, REPORT_KINDS, toCsv } from './reports.js';
import type { AnalyticsRepository } from './repository.js';
import { addDays, daysBetween, MIN_COHORT, ratio } from './stats.js';

export interface Clock {
  now(): Date;
}

export interface AnalyticsDeps {
  repository: AnalyticsRepository;
  directory: Directory;
  upstreams: UpstreamClients;
  embeddings?: EmbeddingClient;
  auth: AuthConfig;
  clock?: Clock;
  logger?: boolean;
}

const uuid = z.string().uuid();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'invalid date');
const MAX_RANGE_DAYS = 186;

const SyllabusSchema = z
  .object({
    items: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(100),
          title: z.string().trim().min(1).max(300),
          keywords: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
          plannedWeek: z.number().int().min(1).max(53).optional(),
        }),
      )
      .max(500),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    s.items.forEach((i, idx) => {
      if (seen.has(i.id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', idx, 'id'],
          message: 'duplicate item id',
        });
      seen.add(i.id);
    });
  });

export function buildApp(deps: AnalyticsDeps): FastifyInstance {
  const clock = deps.clock ?? { now: () => new Date() };
  const today = (): string => clock.now().toISOString().slice(0, 10);
  const up = deps.upstreams;
  const directory = deps.directory;
  const repo = deps.repository;
  const embeddings = deps.embeddings ?? new FakeEmbeddingClient();
  const auth = new Authenticator(deps.auth);
  const facts = new FactSource(repo, directory, up, () => clock.now());
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 16 * 1024 * 1024 });
  // Upstream failures are a gateway problem (502), not a server bug.
  installErrorHandler(app, (err) =>
    err instanceof UpstreamError
      ? new HttpError(502, 'upstream_unavailable', err.message, { service: err.service })
      : null,
  );

  function range(query: unknown, defaultDays = 30): { from: string; to: string } {
    const q = z.object({ from: date.optional(), to: date.optional() }).passthrough().parse(query);
    const to = q.to ?? today();
    const from = q.from ?? addDays(to, -(defaultDays - 1));
    if (to < from) throw new HttpError(400, 'invalid_range', '`to` must be on or after `from`');
    if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS)
      throw new HttpError(400, 'invalid_range', `range may not exceed ${MAX_RANGE_DAYS} days`);
    return { from, to };
  }
  const InstitutionParams = z.object({ id: uuid });
  const flag = (v: unknown, dflt: boolean): boolean =>
    v === undefined ? dflt : z.enum(['true', 'false']).parse(v) === 'true';

  app.get('/health', () => ({ status: 'ok', service: 'academic-analytics' }));

  // ---------------------------------------------------------------- data feeds
  app.post('/v1/sync/sections', async (req) => {
    const { sections } = SectionSyncSchema.parse(req.body);
    await auth.operator(req, [...new Set(sections.map((s) => s.institutionId))]);
    await directory.upsertSections(
      sections.map((s) => ({
        classSectionId: s.classSectionId,
        institutionId: s.institutionId,
        courseId: s.courseId,
        courseCode: s.courseCode ?? null,
        courseName: s.courseName ?? null,
        programId: s.programId ?? null,
        programName: s.programName ?? null,
        professorId: s.professorId ?? null,
        professorName: s.professorName ?? null,
        sectionCode: s.sectionCode ?? null,
        termStartDate: s.termStartDate ?? null,
        termEndDate: s.termEndDate ?? null,
      })),
    );
    return { upserted: sections.length };
  });

  app.post('/v1/sync/enrollments', async (req) => {
    const body = EnrollmentSyncSchema.parse(req.body);
    const section = await directory.section(body.classSectionId);
    if (!section)
      throw new HttpError(
        404,
        'section_not_found',
        `Class section ${body.classSectionId} is not synced`,
      );
    await auth.operator(req, [section.institutionId]);
    const enrolled = await directory.setEnrollments(
      body.classSectionId,
      body.studentIds,
      body.mode,
    );
    return { classSectionId: body.classSectionId, mode: body.mode, enrolled };
  });

  app.post('/v1/sync/classrooms', async (req) => {
    const { classrooms } = ClassroomSyncSchema.parse(req.body);
    await auth.operator(req, [...new Set(classrooms.map((c) => c.institutionId))]);
    await directory.upsertClassrooms(
      classrooms.map((c) => ({ ...c, campusName: c.campusName ?? null, name: c.name ?? null })),
    );
    return { upserted: classrooms.length };
  });

  // ---------------------------------------------------------------- 4.2 syllabus coverage
  async function courseInstitution(courseId: string): Promise<{
    institutionId: string;
    sections: Awaited<ReturnType<Directory['sectionsOfCourse']>>;
  }> {
    const sections = await directory.sectionsOfCourse(courseId);
    const first = sections[0];
    if (!first) throw new HttpError(404, 'course_not_found', `Course ${courseId} is not synced`);
    return { institutionId: first.institutionId, sections };
  }

  app.put('/v1/courses/:courseId/syllabus', async (req) => {
    const { courseId } = z.object({ courseId: uuid }).parse(req.params);
    const body = SyllabusSchema.parse(req.body);
    const { institutionId } = await courseInstitution(courseId);
    const principal = await auth.analyticsWriter(req, institutionId);
    const syllabus = {
      courseId,
      institutionId,
      items: body.items.map((i) => ({
        id: i.id,
        title: i.title,
        keywords: i.keywords,
        plannedWeek: i.plannedWeek ?? null,
      })),
      updatedAt: clock.now().toISOString(),
      updatedBy: actorIdOf(principal),
    };
    await repo.putSyllabus(syllabus);
    return syllabus;
  });

  app.get('/v1/courses/:courseId/syllabus', async (req) => {
    const { courseId } = z.object({ courseId: uuid }).parse(req.params);
    const { institutionId } = await courseInstitution(courseId);
    await auth.analyticsReader(req, institutionId);
    const s = await repo.getSyllabus(courseId);
    if (!s)
      throw new HttpError(404, 'syllabus_not_found', 'No syllabus registered for this course');
    return s;
  });

  app.get('/v1/courses/:courseId/coverage', async (req) => {
    const { courseId } = z.object({ courseId: uuid }).parse(req.params);
    const { institutionId, sections } = await courseInstitution(courseId);
    await auth.analyticsReader(req, institutionId);
    const syllabus = await repo.getSyllabus(courseId);
    if (!syllabus)
      throw new HttpError(404, 'syllabus_not_found', 'No syllabus registered for this course');
    const now = clock.now();
    const start =
      sections
        .map((s) => s.termStartDate)
        .filter((d): d is string => d !== null)
        .sort()[0] ?? addDays(today(), -MAX_RANGE_DAYS);
    const windowFrom = `${addDays(start, -1)}T00:00:00.000Z`;
    const windowTo = now.toISOString();
    const classes = (
      await Promise.all(
        sections.map((s) =>
          up.academic.listScheduledClasses(s.classSectionId, windowFrom, windowTo),
        ),
      )
    )
      .flat()
      .filter((c) => c.status !== 'cancelled' && Date.parse(c.endsAt) <= now.getTime());
    const lectures: LectureForCoverage[] = [];
    for (const c of classes) {
      const lecture = await up.lectures.getLecture(c.id);
      if (lecture) lectures.push({ scheduledClassId: c.id, date: c.localDate, lecture });
    }
    return computeCoverage(syllabus, sections, lectures, embeddings, today());
  });

  // ---------------------------------------------------------------- 4.3 / 4.4 assessments
  app.get('/v1/institutions/:id/assessment-calendar', async (req) => {
    const { id } = InstitutionParams.parse(req.params);
    await auth.analyticsReader(req, id);
    const q = z
      .object({
        programId: uuid.optional(),
        courseId: uuid.optional(),
        includePending: z.string().optional(),
      })
      .passthrough()
      .parse(req.query);
    const { from, to } = range(req.query, 60);
    const { assessments } = await loadAssessments(
      id,
      from,
      to,
      {
        ...(q.programId ? { programId: q.programId } : {}),
        ...(q.courseId ? { courseId: q.courseId } : {}),
        includePending: flag(q.includePending, true),
      },
      directory,
      up,
    );
    return { institutionId: id, from, to, ...(await assessmentCalendar(assessments, directory)) };
  });

  app.get('/v1/institutions/:id/assessment-conflicts', async (req) => {
    const { id } = InstitutionParams.parse(req.params);
    await auth.analyticsReader(req, id);
    const q = z.object({ includePending: z.string().optional() }).passthrough().parse(req.query);
    const { from, to } = range(req.query, 60);
    const { assessments } = await loadAssessments(
      id,
      from,
      to,
      { includePending: flag(q.includePending, true) },
      directory,
      up,
    );
    const conflicts = await detectConflicts(assessments, directory);
    return {
      institutionId: id,
      from,
      to,
      conflicts,
      counts: {
        total: conflicts.length,
        blocking: conflicts.filter((c) => c.severity === 'blocking').length,
        warning: conflicts.filter((c) => c.severity === 'warning').length,
        info: conflicts.filter((c) => c.severity === 'info').length,
      },
    };
  });

  // ---------------------------------------------------------------- 4.5 adoption
  app.get('/v1/institutions/:id/adoption', async (req) => {
    const { id } = InstitutionParams.parse(req.params);
    await auth.analyticsReader(req, id);
    const { from, to } = range(req.query);
    const result = await facts.get(id, from, to);
    return {
      institutionId: id,
      from,
      to,
      source: result.source,
      ...(await adoption(id, from, to, result.facts, directory, up)),
    };
  });

  // ---------------------------------------------------------------- 6.7 learning patterns
  app.get('/v1/courses/:courseId/learning-patterns', async (req) => {
    const { courseId } = z.object({ courseId: uuid }).parse(req.params);
    const { institutionId, sections } = await courseInstitution(courseId);
    await auth.analyticsReader(req, institutionId);
    const { from, to } = range(req.query, 60);
    const inputs = await loadInputs(institutionId, sections, from, to, directory, up);
    const ids = new Set(sections.map((s) => s.classSectionId));
    return {
      courseId,
      institutionId,
      from,
      to,
      minCohort: MIN_COHORT,
      sections: sections.length,
      ...(await learningPatterns(inputs, ids, from, to, up)),
    };
  });

  app.get('/v1/institutions/:id/learning-patterns', async (req) => {
    const { id } = InstitutionParams.parse(req.params);
    await auth.analyticsReader(req, id);
    const { from, to } = range(req.query, 60);
    const sections = await directory.sections(id);
    const inputs = await loadInputs(id, sections, from, to, directory, up);
    const overall = await learningPatterns(
      inputs,
      new Set(sections.map((s) => s.classSectionId)),
      from,
      to,
      up,
    );
    const byCourse = new Map<string, typeof sections>();
    for (const s of sections) byCourse.set(s.courseId, [...(byCourse.get(s.courseId) ?? []), s]);
    const courses = await Promise.all(
      [...byCourse.entries()].map(async ([courseId, list]) => {
        const p = await learningPatterns(
          inputs,
          new Set(list.map((s) => s.classSectionId)),
          from,
          to,
          up,
        );
        return {
          courseId,
          courseCode: list[0]?.courseCode ?? null,
          courseName: list[0]?.courseName ?? null,
          activeStudents: p.activeStudents,
          engagement: p.engagementCurve.summary,
          meanRevisitRate: p.revisitBeforeAssessments.summary.meanRevisitRate,
          meanRevisitLift: p.revisitBeforeAssessments.summary.meanLift,
          zeroResultRate: p.searchesWithoutResults.summary.zeroResultRate,
          topDifficultTopic: p.difficultTopics.topics[0] ?? null,
        };
      }),
    );
    return {
      institutionId: id,
      from,
      to,
      minCohort: MIN_COHORT,
      courses: courses.sort((a, b) =>
        (a.courseCode ?? '').localeCompare(b.courseCode ?? '', 'pt-BR'),
      ),
      overall,
    };
  });

  // ---------------------------------------------------------------- 4.9 reports
  app.get('/v1/institutions/:id/reports/:kind', async (req, reply) => {
    const { id, kind } = z.object({ id: uuid, kind: z.enum(REPORT_KINDS) }).parse(req.params);
    await auth.analyticsReader(req, id);
    const { format } = z
      .object({ format: z.enum(['json', 'csv']).default('json') })
      .passthrough()
      .parse(req.query);
    const { from, to } = range(req.query);
    const result = await facts.get(id, from, to);
    const report = await buildReport(kind, result.facts, directory, id);
    if (format === 'csv') {
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${kind}_${from}_${to}.csv"`)
        .send(toCsv(report.columns, report.rows));
    }
    return {
      institutionId: id,
      from,
      to,
      generatedAt: clock.now().toISOString(),
      source: result.source,
      ...report,
    };
  });

  // ---------------------------------------------------------------- 4.6 overview (composed for administration-web)
  app.get('/v1/institutions/:id/overview', async (req) => {
    const { id } = InstitutionParams.parse(req.params);
    await auth.analyticsReader(req, id);
    const day = z.object({ date: date.optional() }).parse(req.query).date ?? today();
    const settle = async <T>(p: Promise<T>): Promise<{ data: T | null; error: string | null }> => {
      try {
        return { data: await p, error: null };
      } catch (err) {
        return { data: null, error: err instanceof Error ? err.message : String(err) };
      }
    };
    const [dayFacts, fleet, alerts] = await Promise.all([
      settle(facts.get(id, day, day)),
      settle(up.devices.fleetHealth(id)),
      settle(up.notifications.listAlerts(id)),
    ]);
    const classes = dayFacts.data?.facts ?? [];
    const due = classes.filter((f) => f.due && !f.cancelled);
    const open = (alerts.data ?? []).filter((a) => a.status !== 'resolved');
    const bySeverity: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const a of open) bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
    return {
      institutionId: id,
      date: day,
      capture: dayFacts.data
        ? {
            scheduledToday: classes.filter((f) => !f.cancelled).length,
            due: due.length,
            captured: due.filter((f) => f.captured).length,
            coverage: ratio(due.filter((f) => f.captured).length, due.length),
            transcribed: due.filter((f) => f.transcribed).length,
            structured: due.filter((f) => f.structured).length,
            failures: due.filter((f) => f.transcriptionFailed).length,
          }
        : null,
      fleet: fleet.data ? fleet.data.summary : null,
      openAlerts: alerts.data ? { total: open.length, bySeverity } : null,
      errors: Object.fromEntries(
        Object.entries({
          capture: dayFacts.error,
          fleet: fleet.error,
          alerts: alerts.error,
        }).filter(([, v]) => v !== null),
      ),
    };
  });

  // ---------------------------------------------------------------- snapshots
  app.post('/v1/snapshots/run', async (req) => {
    const body = z.object({ institutionId: uuid, date: date.optional() }).parse(req.body);
    await auth.operator(req, [body.institutionId]);
    const day = body.date ?? addDays(today(), -1);
    if (day >= today())
      throw new HttpError(
        422,
        'day_not_closed',
        'Snapshots can only be taken for days that have ended',
      );
    const classes = await facts.collect(body.institutionId, day, day);
    const snapshot = {
      institutionId: body.institutionId,
      date: day,
      generatedAt: clock.now().toISOString(),
      classes,
    };
    await repo.putSnapshot(snapshot);
    return {
      institutionId: body.institutionId,
      date: day,
      generatedAt: snapshot.generatedAt,
      classes: classes.length,
    };
  });

  app.get('/v1/snapshots', async (req) => {
    const q = z.object({ institutionId: uuid }).passthrough().parse(req.query);
    await auth.analyticsReader(req, q.institutionId);
    const { from, to } = range(req.query);
    const snaps = await repo.snapshots(q.institutionId, from, to);
    return {
      items: snaps.map((s) => ({
        date: s.date,
        generatedAt: s.generatedAt,
        classes: s.classes.length,
      })),
    };
  });

  return app;
}
