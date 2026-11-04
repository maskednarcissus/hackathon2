/**
 * Upstream clients. Each interface has an HTTP implementation matching the real endpoint in this
 * repository and an in-memory fake (src/fakes.ts). Responses are parsed leniently with zod and
 * only the fields group-intelligence needs are kept. Group intelligence only ever reads
 * aggregate endpoints — never per-student ones.
 */
import { z } from 'zod';
import type { CampusRef, InstitutionRef } from './domain.js';

export class UpstreamError extends Error {
  constructor(
    readonly service: string,
    message: string,
  ) {
    super(`${service}: ${message}`);
  }
}

export interface HttpOptions {
  baseUrl: string;
  timeoutMs?: number;
  bearerToken?: string;
  internalToken?: string;
}

async function request<T>(
  service: string,
  opts: HttpOptions,
  method: 'GET' | 'POST',
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  body?: unknown,
  allow404 = false,
): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.bearerToken ? { authorization: `Bearer ${opts.bearerToken}` } : {}),
        ...(opts.internalToken ? { 'x-internal-token': opts.internalToken } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (err) {
    throw new UpstreamError(service, `unreachable (${String(err)})`);
  }
  if (allow404 && res.status === 404) return null;
  if (!res.ok) throw new UpstreamError(service, `HTTP ${res.status} for ${method} ${path}`);
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) throw new UpstreamError(service, `unexpected response shape for ${path}`);
  return parsed.data;
}

async function getJson<T>(
  service: string,
  opts: HttpOptions,
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T> {
  const r = await request(service, opts, 'GET', path, schema);
  if (r === null) throw new UpstreamError(service, `empty response for ${path}`);
  return r;
}

export const qs = (params: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

const num = z.number().nullable().catch(null);
const count = z.number().catch(0);

// ---------------------------------------------------------------- organization

export interface OrganizationClient {
  listInstitutions(holdingCompanyId: string): Promise<InstitutionRef[]>;
  listCampuses(institutionId: string): Promise<CampusRef[]>;
}

const InstitutionList = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      holdingCompanyId: z.string(),
      state: z.string().nullable().optional(),
    }),
  ),
});
const CampusList = z.object({
  items: z.array(z.object({ id: z.string(), institutionId: z.string(), name: z.string() })),
});

export class HttpOrganizationClient implements OrganizationClient {
  constructor(private readonly opts: HttpOptions) {}

  async listInstitutions(holdingCompanyId: string): Promise<InstitutionRef[]> {
    const r = await getJson(
      'organization',
      this.opts,
      `/v1/institutions${qs({ holdingCompanyId })}`,
      InstitutionList,
    );
    return r.items.map((i) => ({
      id: i.id,
      name: i.name,
      holdingCompanyId: i.holdingCompanyId,
      state: i.state ?? null,
    }));
  }

  async listCampuses(institutionId: string): Promise<CampusRef[]> {
    const r = await getJson(
      'organization',
      this.opts,
      `/v1/campuses${qs({ institutionId })}`,
      CampusList,
    );
    return r.items;
  }
}

// ---------------------------------------------------------------- academic-analytics

export interface CaptureRow {
  date: string;
  campusId: string | null;
  scheduled: number;
  captured: number;
}

export interface AdoptionProfessor {
  professorId: string;
  classesScheduled: number;
  classesCaptured: number;
  eventsReviewed: number;
}

export interface AdoptionSection {
  classSectionId: string;
  courseId: string | null;
  engagement: {
    suppressed: boolean;
    cohortSize: number | null;
    views: number | null;
    searches: number | null;
    assistantQuestions: number | null;
    activeStudents: number | null;
  };
}

export interface AdoptionResult {
  professors: AdoptionProfessor[];
  sections: AdoptionSection[];
  totals: {
    classesScheduled: number;
    classesCaptured: number;
    classesTranscribed: number;
    classesStructured: number;
    eventsExtracted: number;
    eventsReviewed: number;
    medianReviewLatencyMinutes: number | null;
  };
}

export interface ReportSummaries {
  transcription: { captured: number; transcribed: number; failed: number };
  corrections: {
    transcriptSegmentsCorrected: number;
    eventEdits: number;
    eventRejections: number;
    eventsExtracted: number;
  };
}

export interface AssessmentTotals {
  assessments: number;
  days: number;
  maxDailyLoad: number;
}

export interface AnalyticsClient {
  captureCoverage(institutionId: string, from: string, to: string): Promise<CaptureRow[]>;
  adoption(institutionId: string, from: string, to: string): Promise<AdoptionResult>;
  reportSummaries(institutionId: string, from: string, to: string): Promise<ReportSummaries>;
  assessmentTotals(institutionId: string, from: string, to: string): Promise<AssessmentTotals>;
  conflictCount(institutionId: string, from: string, to: string): Promise<number>;
  /** Null when the course has no registered syllabus. */
  courseCoverageRatio(courseId: string): Promise<number | null>;
}

const CaptureReport = z.object({
  rows: z.array(
    z.object({
      date: z.string(),
      campusId: z.string().nullable().catch(null),
      scheduled: count,
      captured: count,
    }),
  ),
});

const Adoption = z.object({
  professors: z.array(
    z.object({
      professorId: z.string(),
      classesScheduled: count,
      classesCaptured: count,
      eventsReviewed: count,
    }),
  ),
  sections: z.array(
    z.object({
      classSectionId: z.string(),
      courseId: z.string().nullable().catch(null),
      engagement: z
        .object({
          suppressed: z.boolean().catch(true),
          cohortSize: num,
          views: num,
          searches: num,
          assistantQuestions: num,
          activeStudents: num,
        })
        .catch({
          suppressed: true,
          cohortSize: null,
          views: null,
          searches: null,
          assistantQuestions: null,
          activeStudents: null,
        }),
    }),
  ),
  totals: z.object({
    classesScheduled: count,
    classesCaptured: count,
    classesTranscribed: count,
    classesStructured: count,
    eventsExtracted: count,
    eventsReviewed: count,
    medianReviewLatencyMinutes: num,
  }),
});

const Summary = <T extends z.ZodRawShape>(shape: T) => z.object({ summary: z.object(shape) });
const TranscriptionReport = Summary({ captured: count, transcribed: count, failed: count });
const CorrectionsReport = Summary({
  transcriptSegmentsCorrected: count,
  eventEdits: count,
  eventRejections: count,
  eventsExtracted: count,
});
const AssessmentCalendar = z.object({
  totals: z.object({ assessments: count, days: count, maxDailyLoad: count }),
});
const Conflicts = z.object({ counts: z.object({ total: count }) });
const Coverage = z.object({ coverageRatio: num });

export class HttpAnalyticsClient implements AnalyticsClient {
  /** Analytics accepts its INTERNAL_TOKEN as a bearer token for service reads. */
  constructor(private readonly opts: HttpOptions) {}

  private path(institutionId: string, suffix: string, from: string, to: string): string {
    return `/v1/institutions/${institutionId}/${suffix}${qs({ from, to })}`;
  }

  async captureCoverage(institutionId: string, from: string, to: string): Promise<CaptureRow[]> {
    const r = await getJson(
      'academic-analytics',
      this.opts,
      this.path(institutionId, 'reports/capture-coverage', from, to),
      CaptureReport,
    );
    return r.rows;
  }

  async adoption(institutionId: string, from: string, to: string): Promise<AdoptionResult> {
    return getJson(
      'academic-analytics',
      this.opts,
      this.path(institutionId, 'adoption', from, to),
      Adoption,
    );
  }

  async reportSummaries(institutionId: string, from: string, to: string): Promise<ReportSummaries> {
    const [t, c] = await Promise.all([
      getJson(
        'academic-analytics',
        this.opts,
        this.path(institutionId, 'reports/transcription-success', from, to),
        TranscriptionReport,
      ),
      getJson(
        'academic-analytics',
        this.opts,
        this.path(institutionId, 'reports/corrections', from, to),
        CorrectionsReport,
      ),
    ]);
    return { transcription: t.summary, corrections: c.summary };
  }

  async assessmentTotals(
    institutionId: string,
    from: string,
    to: string,
  ): Promise<AssessmentTotals> {
    const r = await getJson(
      'academic-analytics',
      this.opts,
      this.path(institutionId, 'assessment-calendar', from, to),
      AssessmentCalendar,
    );
    return r.totals;
  }

  async conflictCount(institutionId: string, from: string, to: string): Promise<number> {
    const r = await getJson(
      'academic-analytics',
      this.opts,
      this.path(institutionId, 'assessment-conflicts', from, to),
      Conflicts,
    );
    return r.counts.total;
  }

  async courseCoverageRatio(courseId: string): Promise<number | null> {
    const r = await request(
      'academic-analytics',
      this.opts,
      'GET',
      `/v1/courses/${courseId}/coverage`,
      Coverage,
      undefined,
      true,
    );
    return r?.coverageRatio ?? null;
  }
}

// ---------------------------------------------------------------- ai-gateway usage

export interface UsageBucket {
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AiUsage {
  totals: Omit<UsageBucket, 'key'>;
  byTask: UsageBucket[];
  byModel: UsageBucket[];
  byPromptVersion: UsageBucket[];
}

export interface AiUsageClient {
  usage(institutionId: string, fromIso: string, toIso: string): Promise<AiUsage>;
}

const Bucket = z.object({
  calls: count,
  inputTokens: count,
  outputTokens: count,
  costUsd: count,
});
const KeyedBucket = Bucket.extend({ key: z.string() });
const Usage = z.object({
  totals: Bucket,
  byTask: z.array(KeyedBucket).catch([]),
  byModel: z.array(KeyedBucket).catch([]),
  byPromptVersion: z.array(KeyedBucket).catch([]),
});

export class HttpAiUsageClient implements AiUsageClient {
  constructor(private readonly opts: HttpOptions) {}

  async usage(institutionId: string, fromIso: string, toIso: string): Promise<AiUsage> {
    return getJson(
      'ai-gateway',
      this.opts,
      `/v1/usage${qs({ institutionId, from: fromIso, to: toIso })}`,
      Usage,
    );
  }
}

// ---------------------------------------------------------------- device-management

export interface FleetSnapshot {
  total: number;
  byStatus: Record<string, number>;
  byCampus: { campusId: string; total: number; online: number }[];
  firmwareCurrentPct: number | null;
}

export interface DeviceClient {
  fleet(institutionId: string): Promise<FleetSnapshot>;
}

const FleetPage = z.object({
  page: z.number(),
  totalPages: z.number(),
  summary: z.object({ total: count, byStatus: z.record(z.number()) }),
  items: z.array(
    z.object({
      status: z.string(),
      campus: z.object({ id: z.string() }).nullable().catch(null),
    }),
  ),
});
const Firmware = z.object({ total: count, outdated: count });

const OFFLINE_STATUSES = new Set(['offline', 'decommissioned']);

export class HttpDeviceClient implements DeviceClient {
  /** device-management admin routes take the ADMIN_API_TOKEN as bearer. */
  constructor(private readonly opts: HttpOptions) {}

  async fleet(institutionId: string): Promise<FleetSnapshot> {
    const byCampus = new Map<string, { total: number; online: number }>();
    let page = 1;
    let summary: { total: number; byStatus: Record<string, number> } = { total: 0, byStatus: {} };
    for (;;) {
      const r = await getJson(
        'device-management',
        this.opts,
        `/v1/fleet${qs({ institutionId, page, pageSize: 100 })}`,
        FleetPage,
      );
      summary = r.summary;
      for (const item of r.items) {
        if (!item.campus || item.status === 'decommissioned') continue;
        const c = byCampus.get(item.campus.id) ?? { total: 0, online: 0 };
        c.total += 1;
        if (!OFFLINE_STATUSES.has(item.status)) c.online += 1;
        byCampus.set(item.campus.id, c);
      }
      if (r.page >= r.totalPages || page >= 50) break;
      page += 1;
    }
    const fw = await getJson(
      'device-management',
      this.opts,
      `/v1/fleet/firmware${qs({ institutionId })}`,
      Firmware,
    );
    return {
      total: summary.total - (summary.byStatus['decommissioned'] ?? 0),
      byStatus: summary.byStatus,
      byCampus: [...byCampus.entries()].map(([campusId, v]) => ({ campusId, ...v })),
      firmwareCurrentPct:
        fw.total > 0 ? Math.round(((fw.total - fw.outdated) / fw.total) * 1000) / 10 : null,
    };
  }
}

export const onlineDevices = (s: FleetSnapshot): number =>
  Math.max(0, s.total - (s.byStatus['offline'] ?? 0));

// ---------------------------------------------------------------- notifications incidents

export interface IncidentStats {
  raised: number;
  resolved: number;
  mttrMinutes: number | null;
}

export interface IncidentsClient {
  stats(institutionId: string, fromIso: string, toIso: string): Promise<IncidentStats>;
}

const Stats = z.object({ raised: count, resolved: count, mttrMinutes: num });

export class HttpIncidentsClient implements IncidentsClient {
  constructor(private readonly opts: HttpOptions) {}

  async stats(institutionId: string, fromIso: string, toIso: string): Promise<IncidentStats> {
    return getJson(
      'notifications',
      this.opts,
      `/v1/incidents/stats${qs({ institutionId, from: fromIso, to: toIso })}`,
      Stats,
    );
  }
}

// ---------------------------------------------------------------- ai-gateway generate

export interface GenerateRequest {
  promptId: string;
  variables: Record<string, unknown>;
  untrustedInputs: Record<string, string>;
  responseSchema: Record<string, unknown>;
  institutionId: string;
}

export interface GenerateResult {
  output: unknown;
  requestId: string | null;
  model: string | null;
  promptVersion: string | null;
  injectionSuspected: boolean;
}

export interface GatewayClient {
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

/** Gateway task value for investigations — ai-gateway must list it in its Task literal. */
export const INVESTIGATION_TASK = 'group_investigation';

const Generated = z.object({
  requestId: z.string().nullable().catch(null),
  output: z.unknown(),
  model: z.object({ name: z.string() }).nullable().catch(null),
  prompt: z.object({ version: z.string() }).nullable().catch(null),
  safety: z.object({ injectionSuspected: z.boolean() }).catch({ injectionSuspected: false }),
});

export class HttpGatewayClient implements GatewayClient {
  constructor(private readonly opts: HttpOptions) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const r = await request('ai-gateway', this.opts, 'POST', '/v1/generate', Generated, {
      task: INVESTIGATION_TASK,
      promptId: req.promptId,
      variables: req.variables,
      untrustedInputs: req.untrustedInputs,
      responseSchema: req.responseSchema,
      institutionId: req.institutionId,
      requestedBy: 'group-intelligence',
      options: { temperature: 0, maxOutputTokens: 2048 },
    });
    if (r === null) throw new UpstreamError('ai-gateway', 'empty response');
    return {
      output: r.output,
      requestId: r.requestId,
      model: r.model?.name ?? null,
      promptVersion: r.prompt?.version ?? null,
      injectionSuspected: r.safety.injectionSuspected,
    };
  }
}
