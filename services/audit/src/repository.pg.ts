import {
  ANONYMOUS_SUBJECT_ID,
  type ContentReport,
  type ContentReportRepository,
} from './content-reports.js';
import type { ActorType, AuditEvent } from './domain.js';
import { iso, isoOrNull, withTransaction, type Pool } from './platform/pg.js';
import type { AuditQuery, AuditRepository } from './repository.js';

const GLOBAL_TENANT = '00000000-0000-0000-0000-000000000000';

interface AuditRow {
  id: string;
  tenant_institution_id: string | null;
  sequence: number;
  actor_id: string | null;
  actor_type: ActorType;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  occurred_at: Date;
  recorded_at: Date;
  prev_hash: string;
  hash: string;
  position: number;
}

const COLUMNS = `id, tenant_institution_id, sequence, actor_id, actor_type, action, resource_type, resource_id,
  metadata, ip_address, occurred_at, recorded_at, prev_hash, hash, position`;

function toEvent(r: AuditRow): AuditEvent {
  return {
    id: r.id,
    tenantId: r.tenant_institution_id,
    sequence: r.sequence,
    actorId: r.actor_id,
    actorType: r.actor_type,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    metadata: r.metadata,
    ipAddress: r.ip_address,
    occurredAt: iso(r.occurred_at),
    recordedAt: iso(r.recorded_at),
    prevHash: r.prev_hash,
    hash: r.hash,
    position: r.position,
  };
}

const tenantOf = (tenantKey: string): string | null =>
  tenantKey === '__global__' ? null : tenantKey;

/**
 * Append-only audit log on `audit_events` (V001/V002 + pending/audit.sql `position`).
 * Appends are serialised per tenant with a transaction-scoped advisory lock on the tenant key (which
 * also covers empty chains) plus `SELECT … FOR UPDATE` on the current head row. UPDATE and DELETE are
 * rejected by the `trg_audit_events_immutable` trigger.
 */
export class PgAuditRepository implements AuditRepository {
  constructor(private readonly pool: Pool) {}

  append(
    tenantKey: string,
    build: (head: { sequence: number; hash: string } | null, position: number) => AuditEvent,
  ): Promise<AuditEvent> {
    return withTransaction(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 42))', [
        `audit:${tenantKey}`,
      ]);
      const head = await c.query<{ sequence: number; hash: string }>(
        `SELECT sequence, hash FROM audit_events
          WHERE COALESCE(tenant_institution_id, $1::uuid) = COALESCE($2::uuid, $1::uuid)
          ORDER BY sequence DESC LIMIT 1 FOR UPDATE`,
        [GLOBAL_TENANT, tenantOf(tenantKey)],
      );
      const e = build(head.rows[0] ?? null, 0);
      const inserted = await c.query<{ position: number }>(
        `INSERT INTO audit_events (id, tenant_institution_id, sequence, actor_id, actor_type, action,
            resource_type, resource_id, metadata, ip_address, occurred_at, recorded_at, prev_hash, hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING position`,
        [
          e.id,
          e.tenantId,
          e.sequence,
          e.actorId,
          e.actorType,
          e.action,
          e.resourceType,
          e.resourceId,
          e.metadata === null ? null : JSON.stringify(e.metadata),
          e.ipAddress,
          e.occurredAt,
          e.recordedAt,
          e.prevHash,
          e.hash,
        ],
      );
      return { ...e, position: inserted.rows[0]?.position ?? 0 };
    });
  }

  async query(q: AuditQuery): Promise<AuditEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, op: string, value: unknown): void => {
      params.push(value);
      where.push(`${column} ${op} $${params.length}`);
    };
    if (q.afterPosition !== undefined) add('position', '>', q.afterPosition);
    if (q.tenantId !== undefined) add('tenant_institution_id', '=', q.tenantId);
    if (q.resourceType !== undefined) add('resource_type', '=', q.resourceType);
    if (q.resourceId !== undefined) add('resource_id', '=', q.resourceId);
    if (q.action !== undefined) add('action', '=', q.action);
    if (q.from !== undefined) add('occurred_at', '>=', q.from);
    if (q.to !== undefined) add('occurred_at', '<=', q.to);
    params.push(q.limit);
    const res = await this.pool.query<AuditRow>(
      `SELECT ${COLUMNS} FROM audit_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY position LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(toEvent);
  }

  async chain(tenantKey: string): Promise<AuditEvent[]> {
    const res = await this.pool.query<AuditRow>(
      `SELECT ${COLUMNS} FROM audit_events
        WHERE COALESCE(tenant_institution_id, $1::uuid) = COALESCE($2::uuid, $1::uuid) ORDER BY sequence`,
      [GLOBAL_TENANT, tenantOf(tenantKey)],
    );
    return res.rows.map(toEvent);
  }

  async forRecording(recordingSessionId: string): Promise<AuditEvent[]> {
    const res = await this.pool.query<AuditRow>(
      `SELECT ${COLUMNS} FROM audit_events
        WHERE resource_id = $1::uuid OR metadata->>'recordingSessionId' = $1::text ORDER BY position`,
      [recordingSessionId],
    );
    return res.rows.map(toEvent);
  }

  async byActor(actorId: string, limit: number): Promise<AuditEvent[]> {
    const res = await this.pool.query<AuditRow>(
      `SELECT ${COLUMNS} FROM audit_events WHERE actor_id = $1 ORDER BY position LIMIT $2`,
      [actorId, limit],
    );
    return res.rows.map(toEvent);
  }
}

interface ReportRow {
  id: string;
  reporter_id: string;
  reporter_role: ContentReport['reporterRole'];
  institution_id: string;
  resource_type: ContentReport['resourceType'];
  resource_id: string;
  class_section_id: string;
  reason: ContentReport['reason'];
  details: string | null;
  status: 'open' | 'resolved';
  resolution: ContentReport['resolution'];
  resolution_notes: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
}

const toReport = (r: ReportRow): ContentReport => ({
  id: r.id,
  reporterId: r.reporter_id,
  reporterRole: r.reporter_role,
  institutionId: r.institution_id,
  resourceType: r.resource_type,
  resourceId: r.resource_id,
  classSectionId: r.class_section_id,
  reason: r.reason,
  details: r.details,
  status: r.status,
  resolution: r.resolution,
  resolutionNotes: r.resolution_notes,
  resolvedBy: r.resolved_by,
  resolvedAt: isoOrNull(r.resolved_at),
  createdAt: iso(r.created_at),
});

/** `content_reports` (V003). */
export class PgContentReportRepository implements ContentReportRepository {
  constructor(private readonly pool: Pool) {}

  async create(r: ContentReport): Promise<void> {
    await this.pool.query(
      `INSERT INTO content_reports (id, reporter_id, reporter_role, institution_id, resource_type, resource_id,
          class_section_id, reason, details, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        r.id,
        r.reporterId,
        r.reporterRole,
        r.institutionId,
        r.resourceType,
        r.resourceId,
        r.classSectionId,
        r.reason,
        r.details,
        r.status,
        r.createdAt,
      ],
    );
  }

  async get(id: string): Promise<ContentReport | null> {
    const res = await this.pool.query<ReportRow>('SELECT * FROM content_reports WHERE id = $1', [
      id,
    ]);
    const row = res.rows[0];
    return row ? toReport(row) : null;
  }

  async update(r: ContentReport): Promise<void> {
    await this.pool.query(
      `UPDATE content_reports
          SET status = $2, resolution = $3, resolution_notes = $4, resolved_by = $5, resolved_at = $6
        WHERE id = $1`,
      [r.id, r.status, r.resolution, r.resolutionNotes, r.resolvedBy, r.resolvedAt],
    );
  }

  async findOpen(
    reporterId: string,
    resourceType: string,
    resourceId: string,
  ): Promise<ContentReport | null> {
    const res = await this.pool.query<ReportRow>(
      `SELECT * FROM content_reports
        WHERE reporter_id = $1 AND resource_type = $2 AND resource_id = $3 AND status = 'open'`,
      [reporterId, resourceType, resourceId],
    );
    const row = res.rows[0];
    return row ? toReport(row) : null;
  }

  async list(q: {
    classSectionId?: string;
    institutionId?: string;
    status?: 'open' | 'resolved';
    limit: number;
  }): Promise<ContentReport[]> {
    const res = await this.pool.query<ReportRow>(
      `SELECT * FROM content_reports
        WHERE ($1::uuid IS NULL OR class_section_id = $1) AND ($2::uuid IS NULL OR institution_id = $2)
          AND ($3::text IS NULL OR status = $3)
        ORDER BY created_at DESC LIMIT $4`,
      [q.classSectionId ?? null, q.institutionId ?? null, q.status ?? null, q.limit],
    );
    return res.rows.map(toReport);
  }

  async byReporter(reporterId: string): Promise<ContentReport[]> {
    const res = await this.pool.query<ReportRow>(
      'SELECT * FROM content_reports WHERE reporter_id = $1 ORDER BY created_at',
      [reporterId],
    );
    return res.rows.map(toReport);
  }

  async anonymiseReporter(reporterId: string): Promise<number> {
    const res = await this.pool.query(
      'UPDATE content_reports SET reporter_id = $2, details = NULL WHERE reporter_id = $1',
      [reporterId, ANONYMOUS_SUBJECT_ID],
    );
    return res.rowCount ?? 0;
  }
}
