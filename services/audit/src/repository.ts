import type { AuditEvent } from './domain.js';

export interface AuditQuery {
  tenantId?: string;
  resourceType?: string;
  resourceId?: string;
  action?: string;
  from?: string;
  to?: string;
  afterPosition?: number;
  limit: number;
}

/**
 * Append-only store. A Postgres implementation must serialize appends per tenant
 * (e.g. pg_advisory_xact_lock(hashtext(tenant))) so the chain stays linear.
 */
export interface AuditRepository {
  /** Atomically reads the chain head for the tenant and appends the event built from it. */
  append(
    tenantKey: string,
    build: (head: { sequence: number; hash: string } | null, position: number) => AuditEvent,
  ): Promise<AuditEvent>;
  query(q: AuditQuery): Promise<AuditEvent[]>;
  /** All events of one tenant chain in sequence order. */
  chain(tenantKey: string): Promise<AuditEvent[]>;
  forRecording(recordingSessionId: string): Promise<AuditEvent[]>;
}

export const tenantKeyOf = (tenantId: string | null): string => tenantId ?? '__global__';

export class InMemoryAuditRepository implements AuditRepository {
  private readonly events: AuditEvent[] = [];
  private readonly chains = new Map<string, AuditEvent[]>();

  append(
    tenantKey: string,
    build: (head: { sequence: number; hash: string } | null, position: number) => AuditEvent,
  ): Promise<AuditEvent> {
    const chain = this.chains.get(tenantKey) ?? [];
    const last = chain[chain.length - 1];
    const event = build(
      last ? { sequence: last.sequence, hash: last.hash } : null,
      this.events.length + 1,
    );
    chain.push(event);
    this.chains.set(tenantKey, chain);
    this.events.push(event);
    return Promise.resolve(event);
  }

  query(q: AuditQuery): Promise<AuditEvent[]> {
    const out: AuditEvent[] = [];
    for (const e of this.events) {
      if (q.afterPosition !== undefined && e.position <= q.afterPosition) continue;
      if (q.tenantId !== undefined && e.tenantId !== q.tenantId) continue;
      if (q.resourceType !== undefined && e.resourceType !== q.resourceType) continue;
      if (q.resourceId !== undefined && e.resourceId !== q.resourceId) continue;
      if (q.action !== undefined && e.action !== q.action) continue;
      if (q.from !== undefined && e.occurredAt < q.from) continue;
      if (q.to !== undefined && e.occurredAt > q.to) continue;
      out.push(e);
      if (out.length >= q.limit) break;
    }
    return Promise.resolve(out);
  }

  chain(tenantKey: string): Promise<AuditEvent[]> {
    return Promise.resolve([...(this.chains.get(tenantKey) ?? [])]);
  }

  forRecording(recordingSessionId: string): Promise<AuditEvent[]> {
    return Promise.resolve(
      this.events.filter(
        (e) =>
          e.resourceId === recordingSessionId ||
          e.metadata?.['recordingSessionId'] === recordingSessionId,
      ),
    );
  }
}
