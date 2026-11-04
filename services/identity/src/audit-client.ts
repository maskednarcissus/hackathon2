import type { FastifyBaseLogger } from 'fastify';

export type AuditActorType = 'student' | 'professor' | 'coordinator' | 'admin' | 'system';

export interface AuditEventInput {
  tenantId?: string;
  actorId?: string;
  actorType: AuditActorType;
  action:
    | 'auth.login_succeeded'
    | 'auth.login_failed'
    | 'auth.locked'
    | 'auth.refresh_reuse_detected'
    | 'auth.logout'
    | 'auth.user_created';
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

export interface AuditClient {
  /** Never throws: audit delivery failures are logged, not fatal. */
  record(event: AuditEventInput): Promise<void>;
}

export class HttpAuditClient implements AuditClient {
  constructor(
    private readonly baseUrl: string,
    private readonly logger: FastifyBaseLogger,
    private readonly doFetch: typeof fetch = globalThis.fetch,
    private readonly timeoutMs = 2_000,
  ) {}

  async record(event: AuditEventInput): Promise<void> {
    try {
      const response = await this.doFetch(new URL('/v1/audit-events', this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        this.logger.warn({ status: response.status, action: event.action }, 'audit event rejected');
      }
    } catch (err) {
      this.logger.warn({ err, action: event.action }, 'audit event delivery failed');
    }
  }
}

export class InMemoryAuditClient implements AuditClient {
  readonly events: AuditEventInput[] = [];
  async record(event: AuditEventInput): Promise<void> {
    this.events.push(event);
  }
}
