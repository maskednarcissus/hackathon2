/** Audit port — alert lifecycle is part of the recording audit trail (contract §9). */
/** Alert/incident audit actions (Phase 1 §9 + Phase 4 §4 incident queue). */
export type AlertAuditAction =
  | 'alert.raised'
  | 'alert.escalated'
  | 'alert.acknowledged'
  | 'alert.assigned'
  | 'alert.in_progress'
  | 'alert.commented'
  | 'alert.resolved';

export interface AuditRecord {
  action: AlertAuditAction;
  institutionId: string | null;
  actorType: 'system' | 'admin';
  actorId: string | null;
  resourceType: 'alert';
  resourceId: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface AuditClient {
  record(event: AuditRecord): Promise<void>;
}

/** `POST {AUDIT_URL}/v1/audit-events`. */
export class HttpAuditClient implements AuditClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async record(event: AuditRecord): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/v1/audit-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`audit service responded ${res.status}`);
  }
}

export class InMemoryAuditClient implements AuditClient {
  readonly events: AuditRecord[] = [];
  record(event: AuditRecord): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}
