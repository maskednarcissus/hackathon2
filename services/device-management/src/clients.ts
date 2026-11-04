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

export class HttpOrganizationClient implements OrganizationClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 5000,
  ) {}

  async getClassroom(classroomId: string): Promise<ClassroomInfo | null> {
    const res = await fetchJson(
      'organization',
      `${this.baseUrl}/v1/classrooms/${encodeURIComponent(classroomId)}`,
      {},
      this.timeoutMs,
    );
    if (res.status === 404) return null;
    if (!res.ok)
      throw new UpstreamError('organization', res.status, `organization returned ${res.status}`);
    return (await res.json()) as ClassroomInfo;
  }
}

export class HttpScheduleClient implements ScheduleClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 5000,
  ) {}

  async getRecordingPlan(classroomId: string, from: string, to: string): Promise<RecordingPlan> {
    const qs = new URLSearchParams({ from, to });
    const url = `${this.baseUrl}/v1/classrooms/${encodeURIComponent(classroomId)}/recording-plan?${qs.toString()}`;
    const res = await fetchJson('academic-integration', url, {}, this.timeoutMs);
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
  constructor(
    private readonly baseUrl: string,
    private readonly log: FastifyBaseLogger,
    private readonly timeoutMs = 3000,
  ) {}

  async record(event: AuditEventInput): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/audit-events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
