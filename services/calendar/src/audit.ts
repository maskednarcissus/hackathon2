export interface AuditEventInput {
  tenantId?: string;
  actorId?: string;
  actorType: 'student' | 'professor' | 'coordinator' | 'admin' | 'system' | 'device';
  action: 'calendar.event_published' | 'calendar.event_updated';
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditClient {
  record(event: AuditEventInput): Promise<void>;
}

export interface Logger {
  warn(obj: unknown, msg?: string): void;
}

/** Posts to the audit service. Failures are logged and never fail the caller. */
export class HttpAuditClient implements AuditClient {
  constructor(
    private readonly baseUrl: string,
    private readonly logger: Logger,
    private readonly timeoutMs = 2000,
  ) {}

  async record(event: AuditEventInput): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/v1/audit-events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) this.logger.warn({ status: res.status, action: event.action }, 'audit rejected');
    } catch (err) {
      this.logger.warn({ err, action: event.action }, 'audit service unreachable');
    }
  }
}

export class InMemoryAuditClient implements AuditClient {
  readonly events: AuditEventInput[] = [];
  async record(event: AuditEventInput): Promise<void> {
    this.events.push(event);
  }
}
