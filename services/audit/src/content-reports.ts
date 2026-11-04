import { z } from 'zod';

export const REPORT_RESOURCE_TYPES = [
  'lecture_summary',
  'concept',
  'transcript_segment',
  'calendar_event',
  'assistant_answer',
] as const;
export const REPORT_REASONS = [
  'incorrect_date',
  'incorrect_content',
  'misattributed_statement',
  'transcription_error',
  'other',
] as const;
export const REPORT_RESOLUTIONS = [
  'corrected',
  'no_change_needed',
  'duplicate',
  'invalid',
] as const;
export const REPORTER_ROLES = ['student', 'professor', 'coordinator', 'admin'] as const;

export const CreateContentReportSchema = z.object({
  reporterId: z.string().uuid(),
  reporterRole: z.enum(REPORTER_ROLES),
  institutionId: z.string().uuid(),
  resourceType: z.enum(REPORT_RESOURCE_TYPES),
  /** UUID, or a composite key such as `<transcriptId>:<segmentIndex>` for transcript segments. */
  resourceId: z.string().min(1).max(200),
  classSectionId: z.string().uuid(),
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(2000).optional(),
});

export const ResolveContentReportSchema = z.object({
  actorId: z.string().uuid(),
  actorRole: z.enum(['professor', 'coordinator', 'admin']).default('professor'),
  resolution: z.enum(REPORT_RESOLUTIONS),
  notes: z.string().trim().max(2000).optional(),
});

export const ListContentReportsSchema = z
  .object({
    classSectionId: z.string().uuid().optional(),
    institutionId: z.string().uuid().optional(),
    status: z.enum(['open', 'resolved']).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .refine((q) => q.classSectionId !== undefined || q.institutionId !== undefined, {
    message: 'classSectionId or institutionId is required',
  });

export interface ContentReport {
  id: string;
  reporterId: string;
  reporterRole: (typeof REPORTER_ROLES)[number];
  institutionId: string;
  resourceType: (typeof REPORT_RESOURCE_TYPES)[number];
  resourceId: string;
  classSectionId: string;
  reason: (typeof REPORT_REASONS)[number];
  details: string | null;
  status: 'open' | 'resolved';
  resolution: (typeof REPORT_RESOLUTIONS)[number] | null;
  resolutionNotes: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface ContentReportRepository {
  create(report: ContentReport): Promise<void>;
  get(id: string): Promise<ContentReport | null>;
  update(report: ContentReport): Promise<void>;
  findOpen(
    reporterId: string,
    resourceType: string,
    resourceId: string,
  ): Promise<ContentReport | null>;
  list(q: {
    classSectionId?: string;
    institutionId?: string;
    status?: 'open' | 'resolved';
    limit: number;
  }): Promise<ContentReport[]>;
}

export class InMemoryContentReportRepository implements ContentReportRepository {
  private readonly reports = new Map<string, ContentReport>();

  create(report: ContentReport): Promise<void> {
    this.reports.set(report.id, report);
    return Promise.resolve();
  }
  get(id: string): Promise<ContentReport | null> {
    return Promise.resolve(this.reports.get(id) ?? null);
  }
  update(report: ContentReport): Promise<void> {
    this.reports.set(report.id, report);
    return Promise.resolve();
  }
  findOpen(
    reporterId: string,
    resourceType: string,
    resourceId: string,
  ): Promise<ContentReport | null> {
    const found = [...this.reports.values()].find(
      (r) =>
        r.status === 'open' &&
        r.reporterId === reporterId &&
        r.resourceType === resourceType &&
        r.resourceId === resourceId,
    );
    return Promise.resolve(found ?? null);
  }
  list(q: {
    classSectionId?: string;
    institutionId?: string;
    status?: 'open' | 'resolved';
    limit: number;
  }): Promise<ContentReport[]> {
    return Promise.resolve(
      [...this.reports.values()]
        .filter(
          (r) =>
            (q.classSectionId === undefined || r.classSectionId === q.classSectionId) &&
            (q.institutionId === undefined || r.institutionId === q.institutionId) &&
            (q.status === undefined || r.status === q.status),
        )
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, q.limit),
    );
  }
}
