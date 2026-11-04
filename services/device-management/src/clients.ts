import type { FastifyBaseLogger } from 'fastify';

export interface ClassroomInfo {
  id: string;
  campusId: string;
  institutionId: string;
  timezone: string;
  name?: string;
  code?: string;
  campusName?: string;
}

export interface OrganizationClient {
  /** Returns null when the classroom does not exist. */
  getClassroom(classroomId: string): Promise<ClassroomInfo | null>;
}

export interface RecordingPlanWindow {
  scheduledClassId: string;
  classSectionId: string;
  courseId: string;
  professorId: string;
  startsAt: string;
  endsAt: string;
  recordStartAt: string;
  recordStopAt: string;
  recordingPolicyId: string;
  recordingEnabled: boolean;
}

export interface RecordingPlan {
  classroomId: string;
  generatedAt: string;
  timezone: string;
  windows: RecordingPlanWindow[];
}

export interface ScheduleClient {
  getRecordingPlan(classroomId: string, from: string, to: string): Promise<RecordingPlan>;
}

export type AuditActorType =
  'student' | 'professor' | 'coordinator' | 'admin' | 'system' | 'device';

export interface AuditEventInput {
  tenantId: string | null;
  actorId: string | null;
  actorType: AuditActorType;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
}

export interface AuditClient {
  /** Must never throw: audit delivery failures are logged, not propagated. */
  record(event: AuditEventInput): Promise<void>;
}

export interface PlatformEvent {
  eventId: string;
  type: string;
  version: 1;
  occurredAt: string;
  source: 'device-management';
  institutionId: string | null;
  data: Record<string, unknown>;
}

export interface EventPublisher {
  publish(event: PlatformEvent): Promise<void>;
}

export class UpstreamError extends Error {
  constructor(
    public readonly service: string,
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

async function fetchJson(
  service: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new UpstreamError(service, null, `${service} unreachable: ${(err as Error).message}`);
  }
}

export interface HttpClientOptions {
  timeoutMs?: number;
  /** Sent as `x-internal-token` (integration stage §4). */
  internalToken?: string | undefined;
}

const internalHeaders = (token: string | undefined): Record<string, string> =>
  token ? { 'x-internal-token': token } : {};

export class HttpOrganizationClient implements OrganizationClient {
  private readonly timeoutMs: number;
  constructor(
    private readonly baseUrl: string,
    private readonly options: HttpClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async getClassroom(classroomId: string): Promise<ClassroomInfo | null> {
    const res = await fetchJson(
      'organization',
      `${this.baseUrl}/v1/classrooms/${encodeURIComponent(classroomId)}`,
      { headers: internalHeaders(this.options.internalToken) },
      this.timeoutMs,
    );
    if (res.status === 404) return null;
    if (!res.ok)
      throw new UpstreamError('organization', res.status, `organization returned ${res.status}`);
    return (await res.json()) as ClassroomInfo;
  }
}

export class HttpScheduleClient implements ScheduleClient {
  private readonly timeoutMs: number;
  constructor(
    private readonly baseUrl: string,
    private readonly options: HttpClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async getRecordingPlan(classroomId: string, from: string, to: string): Promise<RecordingPlan> {
    const qs = new URLSearchParams({ from, to });
    const url = `${this.baseUrl}/v1/classrooms/${encodeURIComponent(classroomId)}/recording-plan?${qs.toString()}`;
    const res = await fetchJson(
      'academic-integration',
      url,
      { headers: internalHeaders(this.options.internalToken) },
      this.timeoutMs,
    );
    if (!res.ok)
      throw new UpstreamError(
        'academic-integration',
        res.status,
        `academic-integration returned ${res.status}`,
      );
    return (await res.json()) as RecordingPlan;
  }
}

export class HttpAuditClient implements AuditClient {
  private readonly timeoutMs: number;
  constructor(
    private readonly baseUrl: string,
    private readonly log: FastifyBaseLogger,
    private readonly options: HttpClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 3000;
  }

  async record(event: AuditEventInput): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/audit-events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...internalHeaders(this.options.internalToken),
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok)
        this.log.warn({ status: res.status, action: event.action }, 'audit service rejected event');
    } catch (err) {
      this.log.warn({ err, action: event.action }, 'audit service unreachable; event not recorded');
    }
  }
}

/**
 * Integration stage §2: `POST {EVENT_BUS_URL}/v1/topics/{type}:publish` with the envelope as JSON.
 * Throws on failure; callers log (publishing never fails the request that produced the event).
 */
export class HttpEventBusPublisher implements EventPublisher {
  constructor(
    private readonly baseUrl: string,
    private readonly options: HttpClientOptions = {},
  ) {}

  async publish(event: PlatformEvent): Promise<void> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/v1/topics/${encodeURIComponent(event.type)}:publish`;
    const res = await fetchJson(
      'event-bus',
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...internalHeaders(this.options.internalToken),
        },
        body: JSON.stringify(event),
      },
      this.options.timeoutMs ?? 5000,
    );
    if (!res.ok)
      throw new UpstreamError('event-bus', res.status, `event bus returned ${res.status}`);
  }
}

/**
 * Google Pub/Sub over REST (no SDK): topic = event type, data = base64(envelope). Uses the
 * metadata-server access token on GCP, or `PUBSUB_EMULATOR_HOST` (no auth) locally.
 */
export class PubSubRestPublisher implements EventPublisher {
  private token: { value: string; expiresAt: number } | undefined;

  constructor(
    private readonly projectId: string,
    private readonly options: {
      emulatorHost?: string | undefined;
      fetchToken?: () => Promise<{ access_token: string; expires_in: number }>;
      timeoutMs?: number;
    } = {},
  ) {}

  private async accessToken(): Promise<string | undefined> {
    if (this.options.emulatorHost) return undefined;
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const fetchToken =
      this.options.fetchToken ??
      (async (): Promise<{ access_token: string; expires_in: number }> => {
        const res = await fetchJson(
          'gcp-metadata',
          'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
          { headers: { 'Metadata-Flavor': 'Google' } },
          3000,
        );
        if (!res.ok) throw new UpstreamError('gcp-metadata', res.status, 'no access token');
        return (await res.json()) as { access_token: string; expires_in: number };
      });
    const t = await fetchToken();
    this.token = { value: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
    return t.access_token;
  }

  async publish(event: PlatformEvent): Promise<void> {
    const base = this.options.emulatorHost
      ? `http://${this.options.emulatorHost}`
      : 'https://pubsub.googleapis.com';
    const topic = encodeURIComponent(event.type);
    const token = await this.accessToken();
    const res = await fetchJson(
      'pubsub',
      `${base}/v1/projects/${encodeURIComponent(this.projectId)}/topics/${topic}:publish`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          messages: [
            {
              data: Buffer.from(JSON.stringify(event), 'utf8').toString('base64'),
              attributes: { type: event.type, eventId: event.eventId, source: event.source },
            },
          ],
        }),
      },
      this.options.timeoutMs ?? 5000,
    );
    if (!res.ok) throw new UpstreamError('pubsub', res.status, `pubsub returned ${res.status}`);
  }
}

export class LoggingEventPublisher implements EventPublisher {
  constructor(private readonly log: FastifyBaseLogger) {}

  publish(event: PlatformEvent): Promise<void> {
    this.log.info({ event }, `event ${event.type}`);
    return Promise.resolve();
  }
}

export class InMemoryAuditClient implements AuditClient {
  readonly events: AuditEventInput[] = [];
  record(event: AuditEventInput): Promise<void> {
    this.events.push(structuredClone(event));
    return Promise.resolve();
  }
}

export class InMemoryEventPublisher implements EventPublisher {
  readonly events: PlatformEvent[] = [];
  publish(event: PlatformEvent): Promise<void> {
    this.events.push(structuredClone(event));
    return Promise.resolve();
  }
}
