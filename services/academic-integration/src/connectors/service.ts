/**
 * Connector use cases: configuration, sync (pull → canonical import → import pipeline), history,
 * and LMS outbound publication of confirmed calendar events and lecture summaries.
 */
import type { AuditClient } from '../clients.js';
import type { ImportIssue } from '../domain.js';
import { HttpError } from '../errors.js';
import type { ImportRunner } from '../import-runner.js';
import type { AcademicRepository } from '../repository.js';
import type { EventEnvelope } from '../platform/event-bus.js';
import type { ImportPayloadInput } from '../schemas.js';
import { zonedTimeToUtc } from '../tz.js';
import { ConnectorError } from './http.js';
import { escapeHtml } from './lms.js';
import { isLmsConnector, type ConnectorFactory } from './registry.js';
import type {
  ConnectorStore,
  Publication,
  PublicationKind,
  PublicationSource,
  SyncRun,
} from './store.js';
import {
  ConnectorConfigInputSchema,
  isLms,
  issue,
  type Announcement,
  type CalendarItem,
  type ConnectorConfig,
  type ConnectorType,
  type LmsConnector,
  type PullResult,
} from './types.js';

const DEFAULT_TZ = 'America/Sao_Paulo';
const MAX_STORED_WARNINGS = 500;

export interface ConnectorServiceDeps {
  store: ConnectorStore;
  repository: AcademicRepository;
  runImport: ImportRunner;
  factory: ConnectorFactory;
  audit: AuditClient;
  clock: { now(): Date };
  newId: () => string;
}

export interface SyncOptions {
  dryRun: boolean;
  /** Explicit incremental window start; default: the last successful sync (unless `full`). */
  since?: Date;
  full: boolean;
  triggeredBy?: string;
}

export interface OutboundResult {
  eventId: string;
  published: number;
  skipped: number;
  failed: number;
  items: { type: ConnectorType; kind: PublicationKind; status: string; externalId?: string | null; error?: string }[];
}

const formatDate = (d: string): string => {
  const [y, m, day] = d.split('-');
  return `${day ?? ''}/${m ?? ''}/${y ?? ''}`;
};

export class ConnectorService {
  constructor(private readonly deps: ConnectorServiceDeps) {}

  // ------------------------------------------------------------------ config
  async upsertConfig(
    institutionId: string,
    type: ConnectorType,
    body: unknown,
    actor?: string,
  ): Promise<{ config: ConnectorConfig; created: boolean }> {
    const input = ConnectorConfigInputSchema.parse(body);
    if (!isLms(type) && Object.keys(input.outbound.courses).length > 0)
      throw new HttpError(400, 'outbound_not_supported', `${type} is a SIS: outbound publication is LMS-only`);
    const now = this.deps.clock.now().toISOString();
    const existing = await this.deps.store.getConfig(institutionId, type);
    const config: ConnectorConfig = {
      ...input,
      institutionId,
      type,
      lastSuccessfulSyncAt: existing?.lastSuccessfulSyncAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const created = await this.deps.store.saveConfig(config);
    await this.deps.audit.record({
      tenantId: institutionId,
      actorType: 'admin',
      ...(actor ? { actorId: actor } : {}),
      action: 'integration.connector_configured',
      resourceType: 'academic_connector',
      metadata: { type, baseUrl: config.baseUrl, authKind: config.auth.kind, enabled: config.enabled },
    });
    return { config, created };
  }

  getConfig(institutionId: string, type: ConnectorType): Promise<ConnectorConfig | null> {
    return this.deps.store.getConfig(institutionId, type);
  }

  listConfigs(institutionId: string): Promise<ConnectorConfig[]> {
    return this.deps.store.listConfigs(institutionId);
  }

  // -------------------------------------------------------------------- sync
  /**
   * LMS data only adds enrollments: the term must already exist (imported from the SIS), existing
   * students keep their SIS name/e-mail, and enrollments to sections that are not imported yet are
   * dropped with a warning instead of rejecting the whole import.
   */
  private async prepareLms(
    config: ConnectorConfig,
    pull: PullResult,
  ): Promise<{ payload: Omit<ImportPayloadInput, 'institutionId' | 'dryRun'>; warnings: ImportIssue[] }> {
    const termId = config.mappings.termExternalId;
    if (!termId)
      throw new ConnectorError('invalid_config', 'mappings.termExternalId (an imported SIS term) is required for LMS connectors');
    const snap = await this.deps.repository.snapshot(config.institutionId);
    const term = snap.terms.get(termId);
    if (!term)
      throw new ConnectorError('term_not_found', `term ${termId} has not been imported for this institution yet`);
    const warnings: ImportIssue[] = [];
    const sectionsInTerm = new Set(
      [...snap.classSections.values()].filter((s) => s.academicTermId === term.id).map((s) => s.externalId),
    );
    const enrollments = (pull.payload.enrollments ?? []).filter((e) => {
      if (sectionsInTerm.has(e.classSectionExternalId)) return true;
      warnings.push(
        issue(
          `enrollments(${e.studentExternalId}|${e.classSectionExternalId})`,
          'connector.unknown_section',
          `class section ${e.classSectionExternalId} is not imported in term ${termId}; enrollment skipped`,
        ),
      );
      return false;
    });
    const used = new Set(enrollments.map((e) => e.studentExternalId));
    const students = (pull.payload.students ?? [])
      .filter((s) => used.has(s.externalId))
      .map((s) => {
        const existing = snap.students.get(s.externalId);
        return existing ? { externalId: s.externalId, name: existing.name, email: existing.email } : s;
      });
    return {
      payload: {
        timezone: config.mappings.timezone ?? term.timezone,
        term: { externalId: term.externalId, name: term.name, startDate: term.startDate, endDate: term.endDate },
        students,
        enrollments,
      },
      warnings,
    };
  }

  async sync(institutionId: string, type: ConnectorType, opts: SyncOptions): Promise<{ run: SyncRun; httpStatus: number }> {
    const config = await this.deps.store.getConfig(institutionId, type);
    if (!config) throw new HttpError(404, 'connector_not_found', `No ${type} connector for institution ${institutionId}`);
    if (!config.enabled) throw new HttpError(409, 'connector_disabled', `The ${type} connector is disabled`);
    const now = this.deps.clock.now();
    const since = opts.full
      ? undefined
      : (opts.since ?? (config.lastSuccessfulSyncAt ? new Date(config.lastSuccessfulSyncAt) : undefined));
    const run: SyncRun = {
      id: this.deps.newId(),
      institutionId,
      type,
      status: 'running',
      dryRun: opts.dryRun,
      since: since?.toISOString() ?? null,
      triggeredBy: opts.triggeredBy ?? null,
      importId: null,
      importStatus: null,
      counts: null,
      warnings: [],
      errors: [],
      error: null,
      stats: null,
      startedAt: now.toISOString(),
      finishedAt: null,
    };
    if (!(await this.deps.store.startRun(run, now)))
      throw new HttpError(409, 'sync_in_progress', `A ${type} sync is already running for this institution`);

    let httpStatus = 200;
    try {
      const connector = await this.deps.factory.create(config);
      const pull = await connector.pull(since ? { since } : {});
      run.stats = pull.stats;
      let body: Omit<ImportPayloadInput, 'institutionId' | 'dryRun'>;
      let warnings = pull.warnings;
      if (isLms(type)) {
        const prepared = await this.prepareLms(config, pull);
        body = prepared.payload;
        warnings = [...warnings, ...prepared.warnings];
      } else {
        if (!pull.payload.term) throw new ConnectorError('invalid_upstream_data', 'SIS pull returned no term');
        body = { ...pull.payload, term: pull.payload.term, timezone: config.mappings.timezone ?? pull.payload.timezone ?? DEFAULT_TZ };
      }
      const report = await this.deps.runImport(
        { ...body, institutionId, dryRun: opts.dryRun },
        'connector',
        [],
        institutionId,
      );
      run.importId = report.importId;
      run.importStatus = report.status;
      run.counts = report.counts;
      run.errors = report.errors.slice(0, MAX_STORED_WARNINGS);
      run.warnings = [...warnings, ...report.warnings].slice(0, MAX_STORED_WARNINGS);
      if (report.status === 'rejected') {
        run.status = 'rejected';
        httpStatus = 422;
      } else {
        run.status = pull.partial ? 'partial' : 'succeeded';
      }
    } catch (err) {
      if (!(err instanceof ConnectorError)) {
        run.status = 'failed';
        run.error = { code: 'internal_error', message: 'unexpected error during sync' };
        run.finishedAt = this.deps.clock.now().toISOString();
        await this.deps.store.finishRun(run);
        throw err;
      }
      run.status = 'failed';
      run.error = { code: err.code, message: err.message };
      httpStatus = err.code === 'invalid_config' || err.code === 'term_not_found' ? 409 : 502;
    }
    run.finishedAt = this.deps.clock.now().toISOString();
    await this.deps.store.finishRun(run);
    if (!run.dryRun && (run.status === 'succeeded' || run.status === 'partial'))
      await this.deps.store.setLastSuccessfulSync(institutionId, type, run.startedAt);
    await this.deps.audit.record({
      tenantId: institutionId,
      actorType: opts.triggeredBy ? 'admin' : 'system',
      ...(opts.triggeredBy ? { actorId: opts.triggeredBy } : {}),
      action: 'integration.connector_synced',
      resourceType: 'academic_connector_run',
      resourceId: run.id,
      metadata: { type, status: run.status, dryRun: run.dryRun, importId: run.importId, error: run.error?.code ?? null },
    });
    return { run, httpStatus };
  }

  listRuns(institutionId: string, type: ConnectorType, limit: number): Promise<SyncRun[]> {
    return this.deps.store.listRuns(institutionId, type, limit);
  }

  getRun(id: string): Promise<SyncRun | null> {
    return this.deps.store.getRun(id);
  }

  listPublications(institutionId: string, type: ConnectorType, limit: number): Promise<Publication[]> {
    return this.deps.store.listPublications(institutionId, type, limit);
  }

  // ---------------------------------------------------------------- outbound
  private async outboundItems(event: EventEnvelope): Promise<{
    classSectionId: string;
    sourceType: PublicationSource;
    sourceId: string;
    announcement: (config: ConnectorConfig) => Announcement;
    calendarItem: CalendarItem | null;
  } | null> {
    const data = event.data;
    if (event.type === 'calendar.event_published') {
      const ev = (data['event'] ?? {}) as Record<string, unknown>;
      const id = typeof ev['id'] === 'string' ? ev['id'] : typeof data['calendarEventId'] === 'string' ? data['calendarEventId'] : null;
      const classSectionId = typeof ev['classSectionId'] === 'string' ? ev['classSectionId'] : null;
      const date = typeof ev['eventDate'] === 'string' ? ev['eventDate'] : null;
      if (!id || !classSectionId || !date || (typeof ev['status'] === 'string' && ev['status'] !== 'published'))
        return null;
      const title = typeof ev['title'] === 'string' ? ev['title'] : 'Evento acadêmico';
      const description = typeof ev['description'] === 'string' ? ev['description'] : '';
      const time = typeof ev['eventTime'] === 'string' ? ev['eventTime'] : null;
      const tz = typeof ev['timezone'] === 'string' ? ev['timezone'] : DEFAULT_TZ;
      const start = time ? zonedTimeToUtc(date, time, tz) : zonedTimeToUtc(date, '00:00', tz);
      const end = new Date(start.getTime() + (time ? 3_600_000 : 86_400_000));
      const when = `${formatDate(date)}${time ? ` às ${time}` : ''}`;
      return {
        classSectionId,
        sourceType: 'calendar_event',
        sourceId: id,
        announcement: () => ({
          title: `${title} — ${when}`,
          message: `<p><strong>${escapeHtml(title)}</strong> — ${escapeHtml(when)}</p>${
            description ? `<p>${escapeHtml(description)}</p>` : ''
          }<p><em>Confirmado pelo professor no Classroom Intelligence.</em></p>`,
        }),
        calendarItem: {
          title,
          description: escapeHtml(description || title),
          start,
          end,
          allDay: time === null,
        },
      };
    }
    if (event.type === 'lecture.structured') {
      const scheduledClassId = typeof data['scheduledClassId'] === 'string' ? data['scheduledClassId'] : null;
      const summaryId = typeof data['lectureSummaryId'] === 'string' ? data['lectureSummaryId'] : null;
      if (!scheduledClassId || !summaryId) return null;
      const sc = await this.deps.repository.getScheduledClass(scheduledClassId);
      if (!sc) return null;
      return {
        classSectionId: sc.classSectionId,
        sourceType: 'lecture_summary',
        sourceId: summaryId,
        announcement: (config) => {
          const url = config.outbound.lectureUrlTemplate
            ?.replaceAll('{lectureSummaryId}', encodeURIComponent(summaryId))
            .replaceAll('{scheduledClassId}', encodeURIComponent(scheduledClassId))
            .replaceAll('{classSectionId}', encodeURIComponent(sc.classSectionId));
          return {
            title: `Resumo da aula de ${formatDate(sc.localDate)} disponível`,
            message: `<p>O resumo estruturado da aula de ${escapeHtml(formatDate(sc.localDate))} está disponível.</p>${
              url ? `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` : ''
            }`,
          };
        },
        calendarItem: null,
      };
    }
    return null;
  }

  /**
   * Publishes an event to every opted-in LMS course of the institution. Idempotent per source item
   * and kind (`lms_publications`): already published items are skipped, failed ones are retried on
   * redelivery. Returns counts; callers answer non-2xx when anything failed so the bus redelivers.
   */
  async handleEvent(event: EventEnvelope): Promise<OutboundResult> {
    const result: OutboundResult = { eventId: event.eventId, published: 0, skipped: 0, failed: 0, items: [] };
    if (!event.institutionId) return result;
    const item = await this.outboundItems(event);
    if (!item) return result;
    const configs = (await this.deps.store.listConfigs(event.institutionId)).filter(
      (c) => isLms(c.type) && c.enabled && c.outbound.enabled && c.outbound.courses[item.classSectionId],
    );
    for (const config of configs) {
      const course = config.outbound.courses[item.classSectionId];
      if (!course) continue;
      const kinds: PublicationKind[] = [];
      if (course.announcements) kinds.push('announcement');
      if (course.calendarItems && item.calendarItem) kinds.push('calendar_item');
      let connector: LmsConnector | null = null;
      for (const kind of kinds) {
        const key = { institutionId: config.institutionId, type: config.type, sourceType: item.sourceType, sourceId: item.sourceId, kind };
        const existing = await this.deps.store.getPublication(key);
        if (existing?.status === 'published') {
          result.skipped++;
          result.items.push({ type: config.type, kind, status: 'already_published', externalId: existing.externalId });
          continue;
        }
        const now = this.deps.clock.now().toISOString();
        const pub: Publication = existing ?? {
          id: this.deps.newId(),
          ...key,
          classSectionId: item.classSectionId,
          lmsCourseId: course.lmsCourseId,
          status: 'failed',
          externalId: null,
          attempts: 0,
          lastError: null,
          sourceEventId: event.eventId,
          createdAt: now,
          updatedAt: now,
        };
        pub.attempts++;
        pub.updatedAt = now;
        pub.lmsCourseId = course.lmsCourseId;
        try {
          if (!connector) {
            const c = await this.deps.factory.create(config);
            if (!isLmsConnector(c)) throw new ConnectorError('invalid_config', `${config.type} cannot publish`);
            connector = c;
          }
          const target = { lmsCourseId: course.lmsCourseId, forumId: course.forumId };
          const out =
            kind === 'announcement'
              ? await connector.publishAnnouncement(target, item.announcement(config))
              : await connector.publishCalendarItem(target, item.calendarItem as CalendarItem);
          pub.status = 'published';
          pub.externalId = out.externalId;
          pub.lastError = null;
          result.published++;
          result.items.push({ type: config.type, kind, status: 'published', externalId: out.externalId });
        } catch (err) {
          if (!(err instanceof ConnectorError)) throw err;
          pub.status = 'failed';
          pub.lastError = `${err.code}: ${err.message}`.slice(0, 1000);
          result.failed++;
          result.items.push({ type: config.type, kind, status: 'failed', error: pub.lastError });
        }
        await this.deps.store.savePublication(pub);
        if (pub.status === 'published')
          await this.deps.audit.record({
            tenantId: config.institutionId,
            actorType: 'system',
            action: 'integration.lms_published',
            resourceType: 'lms_publication',
            resourceId: pub.id,
            metadata: { type: config.type, kind, sourceType: pub.sourceType, sourceId: pub.sourceId, classSectionId: pub.classSectionId },
          });
      }
    }
    return result;
  }
}
