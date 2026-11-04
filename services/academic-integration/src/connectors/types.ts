/**
 * SIS / LMS connector framework (Phase 6 — 6.5, 6.6).
 *
 * A connector pulls an institution's academic data from an external system and maps it to the
 * canonical import (the body of `POST /v1/imports`); the import pipeline then validates and applies
 * it exactly like a JSON/CSV import. LMS connectors also publish outbound items (announcements,
 * calendar items) for opted-in courses.
 */
import { z } from 'zod';
import type { ImportIssue } from '../domain.js';
import type { ImportPayloadInput } from '../schemas.js';
import { isValidTimeZone } from '../tz.js';

export const SIS_TYPES = ['totvs_rm', 'banner', 'colleague'] as const;
export const LMS_TYPES = ['moodle', 'canvas', 'blackboard'] as const;
export const CONNECTOR_TYPES = [...SIS_TYPES, ...LMS_TYPES] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];
export type LmsType = (typeof LMS_TYPES)[number];
export const ConnectorTypeSchema = z.enum(CONNECTOR_TYPES);

export const isLms = (t: ConnectorType): t is LmsType =>
  (LMS_TYPES as readonly string[]).includes(t);

export const AUTH_KINDS = ['oauth2_client_credentials', 'api_key', 'basic', 'lti13'] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

/**
 * Only a *reference* to the secret is stored (`env:NAME`, `gcp-sm:projects/…/secrets/…/versions/…`).
 * `.strict()` rejects inline credentials (`secret`, `password`, `token`, …).
 */
export const AuthSchema = z
  .object({
    kind: z.enum(AUTH_KINDS),
    secretRef: z
      .string()
      .max(500)
      .regex(/^(env|gcp-sm):[A-Za-z0-9_./-]+$/, 'secretRef must be env:NAME or gcp-sm:<resource>'),
    tokenUrl: z.string().url().optional(),
    scope: z.string().max(1000).optional(),
  })
  .strict();

const uuid = z.string().uuid();

export const MappingsSchema = z
  .object({
    /** Campus timezone for the import (default America/Sao_Paulo). */
    timezone: z.string().refine(isValidTimeZone, 'must be a valid IANA timezone').optional(),
    /** SIS: academic period to import. LMS: term (already imported from the SIS) the enrollments belong to. */
    termExternalId: z.string().min(1).max(100).optional(),
    /** SIS room code / id → classroom id (organization). Unmapped rooms are skipped with a warning. */
    rooms: z.record(z.string().min(1), uuid).default({}),
    /** LMS course / section id → class section externalId. */
    sections: z.record(z.string().min(1), z.string().min(1).max(100)).default({}),
    /** LMS: match courses/sections whose SIS id (idnumber, sis_section_id, externalId) equals a class section externalId. */
    matchByExternalId: z.boolean().default(true),
    defaultDiscipline: z.string().min(1).max(100).default('general'),
    /** Endpoint overrides, e.g. `{ "sections": "/api/custom/v1/turmas" }`. */
    paths: z.record(z.string().min(1), z.string().startsWith('/')).default({}),
    pageSize: z.number().int().min(1).max(1000).default(100),
    concurrency: z.number().int().min(1).max(10).default(4),
    /** Canvas: account whose courses are listed (default: courses visible to the token). */
    accountId: z.string().min(1).max(50).optional(),
    /** TOTVS RM: coligada (company) code. */
    companyId: z.string().min(1).max(20).default('1'),
  })
  .strict();
export type Mappings = z.infer<typeof MappingsSchema>;

export const OutboundCourseSchema = z
  .object({
    lmsCourseId: z.string().min(1).max(100),
    announcements: z.boolean().default(true),
    calendarItems: z.boolean().default(true),
    /** Moodle: news forum id that receives announcements. */
    forumId: z.string().min(1).max(50).optional(),
  })
  .strict();

export const OutboundSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Link to the lecture page; `{lectureSummaryId}`, `{scheduledClassId}`, `{classSectionId}` are substituted. */
    lectureUrlTemplate: z.string().startsWith('https://').max(500).optional(),
    /** Opt-in per course: class section id → LMS course. */
    courses: z.record(uuid, OutboundCourseSchema).default({}),
  })
  .strict();

export const ConnectorConfigInputSchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//.test(u), 'baseUrl must be http(s)')
      .transform((u) => u.replace(/\/+$/, '')),
    enabled: z.boolean().default(true),
    auth: AuthSchema,
    mappings: MappingsSchema.default({}),
    outbound: OutboundSchema.default({}),
  })
  .strict();
export type ConnectorConfigInput = z.input<typeof ConnectorConfigInputSchema>;

export interface ConnectorConfig extends z.infer<typeof ConnectorConfigInputSchema> {
  institutionId: string;
  type: ConnectorType;
  lastSuccessfulSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The canonical import without the fields the sync service owns (institution, dry run). */
export type CanonicalImport = Omit<ImportPayloadInput, 'institutionId' | 'dryRun' | 'term'> & {
  term?: ImportPayloadInput['term'];
};

export interface PullStats {
  requests: number;
  pages: number;
  retries: number;
  rateLimited: number;
  /** Whether `since` was applied (connectors that cannot filter do a full pull). */
  incremental: boolean;
  [extra: string]: number | boolean;
}

export interface PullResult {
  payload: CanonicalImport;
  warnings: ImportIssue[];
  /** Some items could not be fetched (partial failure); the rest is still imported. */
  partial: boolean;
  stats: PullStats;
}

export interface PullContext {
  since?: Date;
}

export interface Connector {
  readonly type: ConnectorType;
  pull(ctx: PullContext): Promise<PullResult>;
}

export interface Announcement {
  title: string;
  /** HTML (already escaped). */
  message: string;
}

export interface CalendarItem {
  title: string;
  description: string;
  start: Date;
  end: Date;
  allDay: boolean;
}

export interface OutboundTarget {
  lmsCourseId: string;
  forumId?: string | undefined;
}

export interface LmsPublisher {
  publishAnnouncement(target: OutboundTarget, item: Announcement): Promise<{ externalId: string }>;
  publishCalendarItem(target: OutboundTarget, item: CalendarItem): Promise<{ externalId: string }>;
}

export type LmsConnector = Connector & LmsPublisher;

export const issue = (path: string, code: string, message: string): ImportIssue => ({
  path,
  code,
  message,
});

/** Runs `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}
