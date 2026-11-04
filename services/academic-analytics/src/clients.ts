/**
 * Upstream clients (no shared database). Each interface has an HTTP implementation matching the
 * real endpoint in this repository and an in-memory fake (src/fakes.ts) for tests and dev.
 * Types only declare the fields analytics uses.
 */

export class UpstreamError extends Error {
  constructor(
    readonly service: string,
    message: string,
  ) {
    super(`${service}: ${message}`);
  }
}

interface HttpOptions {
  baseUrl: string;
  timeoutMs?: number;
  /** Bearer token for services that require one (device-management admin token, identity tokens). */
  bearerToken?: string;
}

async function getJson<T>(
  service: string,
  opts: HttpOptions,
  path: string,
  allow404 = false,
): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(`${opts.baseUrl}${path}`, {
      headers: {
        accept: 'application/json',
        ...(opts.bearerToken ? { authorization: `Bearer ${opts.bearerToken}` } : {}),
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (err) {
    throw new UpstreamError(service, `unreachable (${String(err)})`);
  }
  if (allow404 && res.status === 404) return null;
  if (!res.ok) throw new UpstreamError(service, `HTTP ${res.status} for ${path}`);
  return (await res.json()) as T;
}

const qs = (params: Record<string, string | number | boolean | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, String(v));
  return p.toString();
};

// ---------------------------------------------------------------- academic-integration

export interface ScheduledClass {
  id: string;
  institutionId: string;
  classSectionId: string;
  courseId: string;
  professorId: string;
  classroomId: string;
  localDate: string;
  timezone: string;
  startsAt: string;
  endsAt: string;
  status: 'scheduled' | 'cancelled' | 'in_progress' | 'completed';
}

export interface AcademicClient {
  /** `GET /v1/scheduled-classes?classSectionId&from&to&includeCancelled=true` (classes overlapping the window). */
  listScheduledClasses(classSectionId: string, from: string, to: string): Promise<ScheduledClass[]>;
}

export class HttpAcademicClient implements AcademicClient {
  constructor(private readonly opts: HttpOptions) {}
  async listScheduledClasses(
    classSectionId: string,
    from: string,
    to: string,
  ): Promise<ScheduledClass[]> {
    const body = await getJson<{ items: ScheduledClass[] }>(
      'academic-integration',
      this.opts,
      `/v1/scheduled-classes?${qs({ classSectionId, from, to, includeCancelled: true, limit: 1000 })}`,
    );
    return body?.items ?? [];
  }
}

// ---------------------------------------------------------------- calendar

export interface CalendarEvent {
  id: string;
  institutionId: string;
  courseId: string;
  classSectionId: string;
  extractedEventId: string | null;
  type: string;
  title: string;
  eventDate: string;
  eventTime: string | null;
  isOfficial: boolean;
  status: string; // published | cancelled
}

export interface CalendarClient {
  /** `GET /v1/calendar-events?institutionId&from&to` (dates YYYY-MM-DD). */
  listEvents(institutionId: string, from: string, to: string): Promise<CalendarEvent[]>;
}

export class HttpCalendarClient implements CalendarClient {
  constructor(private readonly opts: HttpOptions) {}
  async listEvents(institutionId: string, from: string, to: string): Promise<CalendarEvent[]> {
    const body = await getJson<{ items: CalendarEvent[] }>(
      'calendar',
      this.opts,
      `/v1/calendar-events?${qs({ institutionId, from, to })}`,
    );
    return body?.items ?? [];
  }
}

// ---------------------------------------------------------------- lecture-intelligence

export interface LectureTopic {
  order?: number;
  title: string;
  description?: string | null;
  startMs?: number | null;
  subtopics?: LectureTopic[];
}

export interface LectureStructure {
  lectureSummaryId: string;
  scheduledClassId: string;
  transcriptId: string;
  title: string;
  topics: LectureTopic[];
  concepts: { term: string; definition: string }[];
  createdAt: string;
}

export interface LectureClient {
  /** `GET /v1/lectures/{scheduledClassId}` → latest structure, null on 404. */
  getLecture(scheduledClassId: string): Promise<LectureStructure | null>;
}

export class HttpLectureClient implements LectureClient {
  constructor(private readonly opts: HttpOptions) {}
  getLecture(scheduledClassId: string): Promise<LectureStructure | null> {
    return getJson<LectureStructure>(
      'lecture-intelligence',
      this.opts,
      `/v1/lectures/${encodeURIComponent(scheduledClassId)}`,
      true,
    );
  }
}

// ---------------------------------------------------------------- audit

export interface AuditEvent {
  id: string;
  tenantId: string | null;
  actorId: string | null;
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  occurredAt: string;
}

export interface AuditClient {
  /** `GET /v1/audit-events?tenantId&action&from&to&limit=500&cursor=…` (all pages). */
  listEvents(tenantId: string, action: string, from: string, to: string): Promise<AuditEvent[]>;
}

export class HttpAuditClient implements AuditClient {
  constructor(
    private readonly opts: HttpOptions,
    private readonly maxPages = 200,
  ) {}
  async listEvents(
    tenantId: string,
    action: string,
    from: string,
    to: string,
  ): Promise<AuditEvent[]> {
    const out: AuditEvent[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const body = await getJson<{ items: AuditEvent[]; nextCursor: string | null }>(
        'audit',
        this.opts,
        `/v1/audit-events?${qs({ tenantId, action, from, to, limit: 500, cursor })}`,
      );
      out.push(...(body?.items ?? []));
      if (!body?.nextCursor) return out;
      cursor = body.nextCursor;
    }
    throw new UpstreamError('audit', 'too many pages');
  }
}

// ---------------------------------------------------------------- transcript-management

export interface TranscriptSummary {
  id: string;
  recordingSessionId: string;
  scheduledClassId: string | null;
  processingVersion: string;
  createdAt: string;
  stats: {
    segmentCount: number;
    averageConfidence: number | null;
    lowConfidenceSegmentCount: number;
    correctedSegmentCount?: number;
  };
}

export interface TranscriptClient {
  /** `GET /v1/transcripts?recordingSessionId=` */
  listByRecording(recordingSessionId: string): Promise<TranscriptSummary[]>;
}

export class HttpTranscriptClient implements TranscriptClient {
  constructor(private readonly opts: HttpOptions) {}
  async listByRecording(recordingSessionId: string): Promise<TranscriptSummary[]> {
    const body = await getJson<{ items: TranscriptSummary[] }>(
      'transcript-management',
      this.opts,
      `/v1/transcripts?${qs({ recordingSessionId })}`,
    );
    return body?.items ?? [];
  }
}

// ---------------------------------------------------------------- event-extraction

export interface ExtractedEventChange {
  changedAt: string;
  changedBy: string;
  source: string; // professor | admin | system | integration
  changeType: string;
  field: string;
}

export interface ExtractedEvent {
  id: string;
  type: string;
  title: string;
  institutionId: string;
  courseId: string;
  classSectionId: string;
  scheduledClassId: string;
  eventDate: string | null;
  eventTime: string | null;
  confirmationStatus: string;
  duplicateOf: string | null;
  calendarEventId?: string | null;
  changeHistory: ExtractedEventChange[];
  createdAt: string;
}

export const ALL_EVENT_STATUSES = [
  'suggested',
  'awaiting_professor',
  'awaiting_admin',
  'confirmed',
  'published',
  'rejected',
] as const;

export interface EventExtractionClient {
  /** `GET /v1/review-queue?classSectionId&status=<all statuses>` */
  listForSection(classSectionId: string): Promise<ExtractedEvent[]>;
}

export class HttpEventExtractionClient implements EventExtractionClient {
  constructor(private readonly opts: HttpOptions) {}
  async listForSection(classSectionId: string): Promise<ExtractedEvent[]> {
    const body = await getJson<ExtractedEvent[]>(
      'event-extraction',
      this.opts,
      `/v1/review-queue?${qs({ classSectionId, status: ALL_EVENT_STATUSES.join(',') })}`,
    );
    return body ?? [];
  }
}

// ---------------------------------------------------------------- device-management

export interface DeviceHealthRow {
  deviceId: string;
  institutionId: string | null;
  classroomId: string | null;
  status: string;
  issues: string[];
  lastSeenAt: string | null;
}

export interface FleetHealth {
  generatedAt: string;
  summary: { total: number; byStatus: Record<string, number>; withIssues: number };
  devices: DeviceHealthRow[];
}

export interface DeviceClient {
  /** `GET /v1/fleet/health?institutionId` (admin bearer token). */
  fleetHealth(institutionId: string): Promise<FleetHealth>;
}

export class HttpDeviceClient implements DeviceClient {
  constructor(private readonly opts: HttpOptions) {}
  async fleetHealth(institutionId: string): Promise<FleetHealth> {
    const body = await getJson<FleetHealth>(
      'device-management',
      this.opts,
      `/v1/fleet/health?${qs({ institutionId })}`,
    );
    if (!body) throw new UpstreamError('device-management', 'empty fleet response');
    return body;
  }
}

// ---------------------------------------------------------------- notifications

export interface Alert {
  id: string;
  rule: string;
  institutionId: string | null;
  classroomId: string | null;
  scheduledClassId: string | null;
  severity: string;
  status: string;
  firstRaisedAt: string;
}

export interface NotificationsClient {
  /** `GET /v1/alerts?institutionId&status&limit=500` */
  listAlerts(institutionId: string, status?: string): Promise<Alert[]>;
}

export class HttpNotificationsClient implements NotificationsClient {
  constructor(private readonly opts: HttpOptions) {}
  async listAlerts(institutionId: string, status?: string): Promise<Alert[]> {
    const body = await getJson<{ alerts: Alert[] }>(
      'notifications',
      this.opts,
      `/v1/alerts?${qs({ institutionId, status, limit: 500 })}`,
    );
    return body?.alerts ?? [];
  }
}
