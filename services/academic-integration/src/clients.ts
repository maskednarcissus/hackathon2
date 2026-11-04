export interface RecordingPolicySummary {
  id: string;
  preRollMinutes: number;
  postRollMinutes: number;
  recordingEnabled: boolean;
}

export interface OrganizationClient {
  /** Effective recording policy of a classroom, or null when none is configured. */
  getClassroomRecordingPolicy(classroomId: string): Promise<RecordingPolicySummary | null>;
}

export class OrganizationUnavailableError extends Error {}

export class HttpOrganizationClient implements OrganizationClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 3000,
  ) {}

  async getClassroomRecordingPolicy(classroomId: string): Promise<RecordingPolicySummary | null> {
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/v1/classrooms/${encodeURIComponent(classroomId)}/recording-policy`,
        {
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (err) {
      throw new OrganizationUnavailableError(`organization service unreachable: ${String(err)}`);
    }
    if (res.status === 404) return null;
    if (!res.ok)
      throw new OrganizationUnavailableError(`organization service returned ${res.status}`);
    const body = (await res.json()) as Partial<RecordingPolicySummary>;
    if (typeof body.id !== 'string')
      throw new OrganizationUnavailableError('invalid recording policy response');
    return {
      id: body.id,
      preRollMinutes: Number(body.preRollMinutes ?? 0),
      postRollMinutes: Number(body.postRollMinutes ?? 0),
      recordingEnabled: body.recordingEnabled !== false,
    };
  }
}

export interface AuditEventInput {
  tenantId?: string;
  actorId?: string;
  actorType: 'student' | 'professor' | 'coordinator' | 'admin' | 'system' | 'device';
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
}

/** Audit emission is best-effort: failures are logged, never propagated to the caller. */
export interface AuditClient {
  record(event: AuditEventInput): Promise<void>;
}

export class HttpAuditClient implements AuditClient {
  constructor(
    private readonly baseUrl: string,
    private readonly onError: (err: unknown) => void = () => undefined,
    private readonly timeoutMs = 2000,
  ) {}

  async record(event: AuditEventInput): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/audit-events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) this.onError(new Error(`audit service returned ${res.status}`));
    } catch (err) {
      this.onError(err);
    }
  }
}

export class InMemoryAuditClient implements AuditClient {
  readonly events: AuditEventInput[] = [];
  record(event: AuditEventInput): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

export class StaticOrganizationClient implements OrganizationClient {
  constructor(private readonly policies: Map<string, RecordingPolicySummary | null> = new Map()) {}
  set(classroomId: string, policy: RecordingPolicySummary | null): void {
    this.policies.set(classroomId, policy);
  }
  getClassroomRecordingPolicy(classroomId: string): Promise<RecordingPolicySummary | null> {
    return Promise.resolve(this.policies.get(classroomId) ?? null);
  }
}
