export interface AuditEventInput {
  tenantId?: string;
  actorId?: string | null;
  actorType: 'student' | 'professor' | 'coordinator' | 'admin' | 'system' | 'device';
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

/** Audit emission is best-effort: failures are reported via `onError`, never thrown. */
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

export interface ScheduledClassInfo {
  id: string;
  classSectionId: string;
  professorId: string;
  institutionId: string;
}

export class AcademicUnavailableError extends Error {}

/** Resolves who teaches a scheduled class (authorization for corrections). */
export interface AcademicClient {
  getScheduledClass(id: string): Promise<ScheduledClassInfo | null>;
}

export class HttpAcademicClient implements AcademicClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 3000,
  ) {}

  async getScheduledClass(id: string): Promise<ScheduledClassInfo | null> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/scheduled-classes/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AcademicUnavailableError(`academic-integration unreachable: ${String(err)}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new AcademicUnavailableError(`academic-integration returned ${res.status}`);
    const b = (await res.json()) as Partial<ScheduledClassInfo>;
    if (
      typeof b.id !== 'string' ||
      typeof b.professorId !== 'string' ||
      typeof b.classSectionId !== 'string'
    ) {
      throw new AcademicUnavailableError('invalid scheduled class response');
    }
    return {
      id: b.id,
      classSectionId: b.classSectionId,
      professorId: b.professorId,
      institutionId: String(b.institutionId ?? ''),
    };
  }
}

export class StaticAcademicClient implements AcademicClient {
  constructor(private readonly classes = new Map<string, ScheduledClassInfo>()) {}
  add(info: ScheduledClassInfo): void {
    this.classes.set(info.id, info);
  }
  getScheduledClass(id: string): Promise<ScheduledClassInfo | null> {
    return Promise.resolve(this.classes.get(id) ?? null);
  }
}
