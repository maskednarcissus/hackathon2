import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  type DeviceDirectory,
  OrganizationUnavailableError,
  type AuditClient,
  type OrganizationClient,
} from './clients.js';
import { timetableCsvToPayload } from './csv.js';
import type { ImportIssue, ImportReport, ScheduledClass } from './domain.js';
import { HttpError, installErrorHandler } from './errors.js';
import { IDENTIFICATION_TOLERANCE_MS, identifyClass, type Candidate } from './identification.js';
import { planImport } from './importer.js';
import { requireInternalToken } from './platform/internal-auth.js';
import {
  DuplicateDataError,
  MissingReferenceError,
  type AcademicRepository,
} from './repository.js';
import type { SyncService } from './sync.js';
import { buildAlertContext } from './alert-context.js';
import { ImportPayloadSchema, formatPath, type ImportPayloadInput } from './schemas.js';

export interface Clock {
  now(): Date;
}

export interface AcademicDeps {
  repository: AcademicRepository;
  organization: OrganizationClient;
  audit: AuditClient;
  clock?: Clock;
  idGenerator?: () => string;
  logger?: boolean;
  /** Academic data push to identity / calendar / notifications / analytics (integration-stage §3). */
  sync?: SyncService;
  /** Assigned devices per classroom for the alert-context feed. */
  devices?: DeviceDirectory;
  /** INTERNAL_API_TOKEN: required as x-internal-token on /internal/* and sync routes when set. */
  internalToken?: string;
}

const iso = z.string().datetime({ offset: true });
const IdParams = z.object({ id: z.string().uuid() });
const MAX_PLAN_RANGE_MS = 14 * 86_400_000;
const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

const IdentificationSchema = z
  .object({
    classroomId: z.string().uuid(),
    startedAt: iso,
    endedAt: iso,
    recordingSessionId: z.string().uuid().optional(),
    deviceId: z.string().uuid().optional(),
  })
  .refine((v) => Date.parse(v.endedAt) > Date.parse(v.startedAt), {
    message: 'endedAt must be after startedAt',
    path: ['endedAt'],
  });

const emptyCounts = (): ImportReport['counts'] => {
  const c = () => ({ created: 0, updated: 0, unchanged: 0 });
  return {
    terms: c(),
    courses: c(),
    professors: c(),
    students: c(),
    classSections: c(),
    enrollments: c(),
    scheduledClasses: c(),
    scheduledClassesCancelled: 0,
  };
};

export function buildApp(deps: AcademicDeps): FastifyInstance {
  const repo = deps.repository;
  const clock = deps.clock ?? { now: () => new Date() };
  const newId = deps.idGenerator ?? randomUUID;
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 32 * 1024 * 1024 });
  installErrorHandler(app, (err) => {
    if (err instanceof MissingReferenceError) {
      return new HttpError(
        422,
        'unknown_reference',
        'The import references an entity that does not exist (e.g. a classroom unknown to organization)',
        { constraint: err.constraint },
      );
    }
    if (err instanceof DuplicateDataError) {
      return new HttpError(409, 'conflicting_data', err.message, { constraint: err.constraint });
    }
    return null;
  });
  const internal = { preHandler: requireInternalToken(deps.internalToken) };
  app.addHook('onClose', () => {
    deps.sync?.stop();
    return Promise.resolve();
  });
  app.addContentTypeParser(
    ['text/csv', 'application/csv'],
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );

  async function runImport(
    raw: unknown,
    format: 'json' | 'csv',
    preErrors: ImportIssue[],
    institutionIdHint: string | null,
  ): Promise<ImportReport> {
    const importId = newId();
    const createdAt = clock.now().toISOString();
    const parsed = preErrors.length === 0 ? ImportPayloadSchema.safeParse(raw) : null;
    if (!parsed || !parsed.success) {
      const errors =
        parsed && !parsed.success
          ? parsed.error.issues.map((i) => ({
              path: formatPath(i.path) || '(root)',
              code: i.code,
              message: i.message,
            }))
          : preErrors;
      const institutionId =
        typeof (raw as { institutionId?: unknown } | null)?.institutionId === 'string'
          ? String((raw as { institutionId: string }).institutionId)
          : (institutionIdHint ?? '');
      const dryRun = (raw as { dryRun?: unknown } | null)?.dryRun === true;
      const report: ImportReport = {
        importId,
        institutionId,
        format,
        dryRun,
        status: 'rejected',
        errors,
        warnings: [],
        counts: emptyCounts(),
        createdAt,
      };
      await repo.saveImportReport(report);
      return report;
    }
    const payload = parsed.data;
    const plan = planImport(payload, await repo.snapshot(payload.institutionId), newId);
    const rejected = plan.errors.length > 0;
    if (!rejected && !payload.dryRun) {
      await repo.apply(plan.changes);
      // Fire-and-forget: the import response never waits for downstream services.
      deps.sync
        ?.schedule(payload.institutionId)
        .catch((err: unknown) => app.log.warn({ err }, 'sync push failed'));
    }
    const report: ImportReport = {
      importId,
      institutionId: payload.institutionId,
      format,
      dryRun: payload.dryRun,
      status: rejected ? 'rejected' : payload.dryRun ? 'validated' : 'applied',
      errors: plan.errors,
      warnings: plan.warnings,
      counts: plan.counts,
      createdAt,
    };
    await repo.saveImportReport(report);
    return report;
  }

  const statusFor = (r: ImportReport): number =>
    r.status === 'rejected' ? 422 : r.status === 'validated' ? 200 : 201;

  app.get('/health', () => ({ status: 'ok', service: 'academic-integration' }));

  app.post('/v1/imports', async (req, reply) => {
    const report = await runImport(req.body, 'json', [], null);
    return reply.status(statusFor(report)).send(report);
  });

  app.post('/v1/imports/timetable.csv', async (req, reply) => {
    const q = z
      .object({
        institutionId: z.string().uuid(),
        timezone: z.string().optional(),
        dryRun: z
          .enum(['true', 'false'])
          .default('false')
          .transform((v) => v === 'true'),
      })
      .parse(req.query);
    if (typeof req.body !== 'string')
      throw new HttpError(415, 'unsupported_media_type', 'Send the timetable as text/csv');
    const conversion = timetableCsvToPayload(req.body, q.institutionId, q.timezone);
    const raw: ImportPayloadInput | null = conversion.payload
      ? { ...conversion.payload, dryRun: q.dryRun }
      : null;
    const report = await runImport(raw, 'csv', conversion.errors, q.institutionId);
    return reply.status(statusFor(report)).send(report);
  });

  app.get('/v1/imports/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const report = await repo.getImportReport(id);
    if (!report) throw new HttpError(404, 'import_not_found', `Import ${id} not found`);
    return report;
  });

  app.get('/v1/scheduled-classes', async (req) => {
    const q = z
      .object({
        classroomId: z.string().uuid().optional(),
        classSectionId: z.string().uuid().optional(),
        from: iso.optional(),
        to: iso.optional(),
        includeCancelled: z
          .enum(['true', 'false'])
          .default('false')
          .transform((v) => v === 'true'),
        limit: z.coerce.number().int().min(1).max(1000).default(200),
      })
      .refine((v) => v.classroomId !== undefined || v.classSectionId !== undefined, {
        message: 'classroomId or classSectionId is required',
      })
      .parse(req.query);
    const items = await repo.findScheduledClasses({
      ...(q.classroomId !== undefined ? { classroomId: q.classroomId } : {}),
      ...(q.classSectionId !== undefined ? { classSectionId: q.classSectionId } : {}),
      ...(q.from !== undefined ? { from: new Date(q.from).toISOString() } : {}),
      ...(q.to !== undefined ? { to: new Date(q.to).toISOString() } : {}),
      includeCancelled: q.includeCancelled,
    });
    return { items: items.slice(0, q.limit), truncated: items.length > q.limit };
  });

  async function describe(sc: ScheduledClass): Promise<Record<string, unknown>> {
    const [section, course, professor] = await Promise.all([
      repo.getClassSection(sc.classSectionId),
      repo.getCourse(sc.courseId),
      repo.getProfessor(sc.professorId),
    ]);
    const term = section ? await repo.getTerm(section.academicTermId) : null;
    return {
      ...sc,
      classSection: section
        ? { id: section.id, externalId: section.externalId, sectionCode: section.sectionCode }
        : null,
      course: course
        ? {
            id: course.id,
            externalId: course.externalId,
            code: course.code,
            name: course.name,
            discipline: course.discipline,
          }
        : null,
      professor: professor
        ? { id: professor.id, externalId: professor.externalId, name: professor.name }
        : null,
      term: term ? { id: term.id, externalId: term.externalId, name: term.name } : null,
    };
  }

  app.get('/v1/scheduled-classes/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const sc = await repo.getScheduledClass(id);
    if (!sc)
      throw new HttpError(404, 'scheduled_class_not_found', `Scheduled class ${id} not found`);
    return describe(sc);
  });

  /** Roster for consent checks (organization): who teaches and who is actively enrolled. */
  app.get('/v1/class-sections/:id/roster', async (req) => {
    const { id } = IdParams.parse(req.params);
    const section = await repo.getClassSection(id);
    if (!section)
      throw new HttpError(404, 'class_section_not_found', `Class section ${id} not found`);
    const enrollments = await repo.enrollmentsOfSection(id);
    return {
      classSectionId: section.id,
      institutionId: section.institutionId,
      professorIds: [section.professorId],
      studentIds: enrollments
        .filter((e) => e.status === 'active')
        .map((e) => e.studentId)
        .sort(),
    };
  });

  app.post('/v1/class-identification', async (req) => {
    const input = IdentificationSchema.parse(req.body);
    const startedAt = new Date(input.startedAt);
    const endedAt = new Date(input.endedAt);
    const candidates = await repo.findScheduledClasses({
      classroomId: input.classroomId,
      from: new Date(startedAt.getTime() - IDENTIFICATION_TOLERANCE_MS).toISOString(),
      to: new Date(endedAt.getTime() + IDENTIFICATION_TOLERANCE_MS).toISOString(),
    });
    const result = identifyClass({ startedAt, endedAt }, candidates);
    const brief = (c: Candidate): Record<string, unknown> => ({
      scheduledClassId: c.scheduledClass.id,
      classSectionId: c.scheduledClass.classSectionId,
      courseId: c.scheduledClass.courseId,
      startsAt: c.scheduledClass.startsAt,
      endsAt: c.scheduledClass.endsAt,
      score: c.score,
      overlapMs: c.overlapMs,
    });
    const best = result.best?.scheduledClass;
    await deps.audit.record({
      ...(best ? { tenantId: best.institutionId } : {}),
      actorType: 'system',
      action: 'recording.class_identified',
      resourceType: 'recording_session',
      ...(input.recordingSessionId !== undefined ? { resourceId: input.recordingSessionId } : {}),
      metadata: {
        ...(input.recordingSessionId !== undefined
          ? { recordingSessionId: input.recordingSessionId }
          : {}),
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        classroomId: input.classroomId,
        status: result.status,
        confidence: result.confidence,
        scheduledClassId: best?.id ?? null,
      },
    });
    return {
      status: result.status,
      confidence: result.confidence,
      reason: result.reason,
      scheduledClass: best && result.status === 'matched' ? await describe(best) : null,
      bestCandidate: result.best ? brief(result.best) : null,
      alternatives: result.alternatives.map(brief),
    };
  });

  app.get('/v1/classrooms/:id/recording-plan', async (req) => {
    const { id } = IdParams.parse(req.params);
    const q = z.object({ from: iso.optional(), to: iso.optional() }).parse(req.query);
    const now = clock.now();
    const from = q.from ? new Date(q.from) : now;
    const to = q.to ? new Date(q.to) : new Date(from.getTime() + 86_400_000);
    if (to <= from) throw new HttpError(400, 'invalid_range', '`to` must be after `from`');
    if (to.getTime() - from.getTime() > MAX_PLAN_RANGE_MS)
      throw new HttpError(400, 'invalid_range', 'range may not exceed 14 days');

    let policy;
    try {
      policy = await deps.organization.getClassroomRecordingPolicy(id);
    } catch (err) {
      if (err instanceof OrganizationUnavailableError)
        throw new HttpError(502, 'organization_unavailable', err.message);
      throw err;
    }
    const pre = (policy?.preRollMinutes ?? 0) * 60_000;
    const post = (policy?.postRollMinutes ?? 0) * 60_000;
    const classes = await repo.findScheduledClasses({
      classroomId: id,
      from: new Date(from.getTime() - post).toISOString(),
      to: new Date(to.getTime() + pre).toISOString(),
    });
    const windows = classes.map((c) => {
      const enabled = policy?.recordingEnabled === true;
      return {
        scheduledClassId: c.id,
        classSectionId: c.classSectionId,
        courseId: c.courseId,
        professorId: c.professorId,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        recordStartAt: new Date(Date.parse(c.startsAt) - pre).toISOString(),
        recordStopAt: new Date(Date.parse(c.endsAt) + post).toISOString(),
        recordingPolicyId: policy?.id ?? null,
        recordingEnabled: enabled,
        ...(enabled ? {} : { disabledReason: policy ? 'policy_disabled' : 'no_recording_policy' }),
      };
    });
    return {
      classroomId: id,
      generatedAt: now.toISOString(),
      timezone: classes[0]?.timezone ?? DEFAULT_TIMEZONE,
      from: from.toISOString(),
      to: to.toISOString(),
      windows,
    };
  });

  // ---- Sync push (integration-stage §3) ----
  app.get('/v1/sync/status', internal, async () => {
    if (deps.sync) await Promise.race([deps.sync.idle(), new Promise((r) => setTimeout(r, 50))]);
    return { targets: deps.sync?.snapshot() ?? [] };
  });

  app.post('/v1/sync/push', internal, async (req) => {
    const body = z
      .object({
        institutionId: z.string().uuid(),
        targets: z.array(z.string().min(1)).max(20).optional(),
      })
      .parse(req.body);
    if (!deps.sync || deps.sync.targets.length === 0) {
      throw new HttpError(409, 'sync_not_configured', 'No SYNC_TARGETS are configured');
    }
    const unknown = (body.targets ?? []).filter(
      (t) => !deps.sync?.targets.some((x) => x.name === t),
    );
    if (unknown.length > 0)
      throw new HttpError(400, 'unknown_target', `Unknown sync targets: ${unknown.join(', ')}`);
    const results = await deps.sync.schedule(body.institutionId, body.targets);
    return { institutionId: body.institutionId, results, targets: deps.sync.snapshot() };
  });

  // ---- Alert context for notifications /v1/alerts/evaluate (integration-stage §6) ----
  app.get('/internal/v1/alert-context', internal, async (req) => {
    const q = z
      .object({
        institutionId: z.string().uuid().optional(),
        at: iso.optional(),
        lookbackMinutes: z.coerce.number().int().min(0).max(1440).default(240),
        lookaheadMinutes: z.coerce.number().int().min(0).max(1440).default(60),
      })
      .parse(req.query);
    return buildAlertContext(
      {
        ...(q.institutionId !== undefined ? { institutionId: q.institutionId } : {}),
        at: q.at ? new Date(q.at) : clock.now(),
        lookbackMinutes: q.lookbackMinutes,
        lookaheadMinutes: q.lookaheadMinutes,
      },
      repo,
      deps.organization,
      deps.devices,
    );
  });

  return app;
}
