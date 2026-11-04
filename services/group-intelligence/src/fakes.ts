/** In-memory upstream fakes for tests and local development. */
import type {
  AdoptionResult,
  AiUsage,
  AiUsageClient,
  AnalyticsClient,
  AssessmentTotals,
  CaptureRow,
  DeviceClient,
  FleetSnapshot,
  GatewayClient,
  GenerateRequest,
  GenerateResult,
  IncidentsClient,
  IncidentStats,
  OrganizationClient,
  ReportSummaries,
} from './clients.js';
import { UpstreamError } from './clients.js';
import type { CampusRef, InstitutionRef } from './domain.js';

export class FakeOrganization implements OrganizationClient {
  institutions: InstitutionRef[] = [];
  campuses: CampusRef[] = [];

  async listInstitutions(holdingCompanyId: string): Promise<InstitutionRef[]> {
    return this.institutions.filter((i) => i.holdingCompanyId === holdingCompanyId);
  }

  async listCampuses(institutionId: string): Promise<CampusRef[]> {
    return this.campuses.filter((c) => c.institutionId === institutionId);
  }
}

const key = (institutionId: string, date: string): string => `${institutionId}|${date}`;

export const emptyAdoption = (): AdoptionResult => ({
  professors: [],
  sections: [],
  totals: {
    classesScheduled: 0,
    classesCaptured: 0,
    classesTranscribed: 0,
    classesStructured: 0,
    eventsExtracted: 0,
    eventsReviewed: 0,
    medianReviewLatencyMinutes: null,
  },
});

export class FakeAnalytics implements AnalyticsClient {
  capture = new Map<string, CaptureRow[]>();
  adoptions = new Map<string, AdoptionResult>();
  summaries = new Map<string, ReportSummaries>();
  assessments = new Map<string, AssessmentTotals>();
  conflicts = new Map<string, number>();
  coverage = new Map<string, number>();
  failing = new Set<string>();
  /** Range-level adoption used by academic indicators (keyed by institution). */
  rangeAdoption = new Map<string, AdoptionResult>();

  private check(institutionId: string): void {
    if (this.failing.has(institutionId)) throw new UpstreamError('academic-analytics', 'HTTP 502');
  }

  async captureCoverage(institutionId: string, from: string): Promise<CaptureRow[]> {
    this.check(institutionId);
    return this.capture.get(key(institutionId, from)) ?? [];
  }

  async adoption(institutionId: string, from: string, to: string): Promise<AdoptionResult> {
    this.check(institutionId);
    if (from !== to) return this.rangeAdoption.get(institutionId) ?? emptyAdoption();
    return this.adoptions.get(key(institutionId, from)) ?? emptyAdoption();
  }

  async reportSummaries(institutionId: string): Promise<ReportSummaries> {
    this.check(institutionId);
    return (
      this.summaries.get(institutionId) ?? {
        transcription: { captured: 0, transcribed: 0, failed: 0 },
        corrections: {
          transcriptSegmentsCorrected: 0,
          eventEdits: 0,
          eventRejections: 0,
          eventsExtracted: 0,
        },
      }
    );
  }

  async assessmentTotals(institutionId: string): Promise<AssessmentTotals> {
    this.check(institutionId);
    return this.assessments.get(institutionId) ?? { assessments: 0, days: 0, maxDailyLoad: 0 };
  }

  async conflictCount(institutionId: string): Promise<number> {
    this.check(institutionId);
    return this.conflicts.get(institutionId) ?? 0;
  }

  async courseCoverageRatio(courseId: string): Promise<number | null> {
    return this.coverage.get(courseId) ?? null;
  }
}

export class FakeAiUsage implements AiUsageClient {
  usages = new Map<string, AiUsage>();

  /** Keyed by `institution|date` for single-day queries, or by institution for longer ranges. */
  async usage(institutionId: string, fromIso: string, toIso: string): Promise<AiUsage> {
    const singleDay = Date.parse(toIso) - Date.parse(fromIso) <= 86_400_000;
    return (
      (singleDay ? this.usages.get(key(institutionId, fromIso.slice(0, 10))) : undefined) ??
      this.usages.get(institutionId) ?? {
        totals: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
        byTask: [],
        byModel: [],
        byPromptVersion: [],
      }
    );
  }
}

export class FakeDevices implements DeviceClient {
  fleets = new Map<string, FleetSnapshot>();

  async fleet(institutionId: string): Promise<FleetSnapshot> {
    return (
      this.fleets.get(institutionId) ?? {
        total: 0,
        byStatus: {},
        byCampus: [],
        firmwareCurrentPct: null,
      }
    );
  }
}

export class FakeIncidents implements IncidentsClient {
  stats_ = new Map<string, IncidentStats>();

  async stats(institutionId: string, fromIso: string): Promise<IncidentStats> {
    return (
      this.stats_.get(key(institutionId, fromIso.slice(0, 10))) ?? {
        raised: 0,
        resolved: 0,
        mttrMinutes: null,
      }
    );
  }
}

/** Scripted gateway: a function per prompt id returning the model's JSON output. */
export class FakeGateway implements GatewayClient {
  calls: GenerateRequest[] = [];
  injection = false;

  constructor(private readonly script: Record<string, (req: GenerateRequest) => unknown> = {}) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    const fn = this.script[req.promptId];
    if (!fn) throw new UpstreamError('ai-gateway', `no scripted output for ${req.promptId}`);
    return {
      output: fn(req),
      requestId: `req-${this.calls.length}`,
      model: 'fake/fake-1',
      promptVersion: '2026-11-04.1',
      injectionSuspected: this.injection,
    };
  }
}
