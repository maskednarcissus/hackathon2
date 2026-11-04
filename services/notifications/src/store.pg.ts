import type pg from 'pg';
import { iso, isoRequired, isUuid } from './db.js';
import type { Alert, Delivery, IncidentActivity, IncidentComment } from './domain.js';
import type { AlertQuery } from './schemas.js';
import type { AlertStore, ClassMark, IncidentFilter } from './store.js';

/** Postgres adapter for alerts / incidents (tables from V003 §8, V004 §5, pending/notifications.sql). */
export class PgAlertStore implements AlertStore {
  constructor(private readonly pool: pg.Pool) {}

  private static readonly COLUMNS = `id, rule, dedupe_key, resource_type, resource_id, institution_id,
    classroom_id, campus_id, classroom_name, campus_name, device_id, scheduled_class_id,
    recording_session_id, severity, status, title, message, details, first_raised_at, last_seen_at,
    last_notified_at, notification_count, occurrences, acknowledged_at, acknowledged_by, resolved_at,
    resolved_by, resolution, resolution_note, assignee_id, assigned_at, in_progress_at,
    resolution_code, sla_due_at`;

  private static params(a: Alert): unknown[] {
    return [
      a.id,
      a.rule,
      a.dedupeKey,
      a.resourceType,
      a.resourceId,
      a.institutionId,
      a.classroomId,
      a.campusId,
      a.classroomName,
      a.campusName,
      a.deviceId,
      a.scheduledClassId,
      a.recordingSessionId,
      a.severity,
      a.status,
      a.title,
      a.message,
      JSON.stringify(a.details ?? {}),
      a.firstRaisedAt,
      a.lastSeenAt,
      a.lastNotifiedAt,
      a.notificationCount,
      a.occurrences,
      a.acknowledgedAt,
      a.acknowledgedBy,
      a.resolvedAt,
      a.resolvedBy,
      a.resolution,
      a.resolutionNote,
      a.assigneeId,
      a.assignedAt,
      a.inProgressAt,
      a.resolutionCode,
      a.slaDueAt,
    ];
  }

  private static readonly PLACEHOLDERS = Array.from({ length: 34 }, (_, i) => `$${i + 1}`).join(
    ', ',
  );

  private static row(r: Record<string, unknown>): Alert {
    const s = (k: string): string | null =>
      r[k] === null || r[k] === undefined ? null : String(r[k]);
    return {
      id: String(r.id),
      rule: r.rule as Alert['rule'],
      dedupeKey: String(r.dedupe_key),
      resourceType: r.resource_type as Alert['resourceType'],
      resourceId: String(r.resource_id),
      institutionId: s('institution_id'),
      classroomId: s('classroom_id'),
      campusId: s('campus_id'),
      classroomName: s('classroom_name'),
      campusName: s('campus_name'),
      deviceId: s('device_id'),
      scheduledClassId: s('scheduled_class_id'),
      recordingSessionId: s('recording_session_id'),
      severity: r.severity as Alert['severity'],
      status: r.status as Alert['status'],
      title: String(r.title),
      message: String(r.message),
      details: (r.details ?? {}) as Record<string, unknown>,
      firstRaisedAt: isoRequired(r.first_raised_at as Date),
      lastSeenAt: isoRequired(r.last_seen_at as Date),
      lastNotifiedAt: iso(r.last_notified_at as Date | null),
      notificationCount: Number(r.notification_count),
      occurrences: Number(r.occurrences),
      acknowledgedAt: iso(r.acknowledged_at as Date | null),
      acknowledgedBy: s('acknowledged_by'),
      resolvedAt: iso(r.resolved_at as Date | null),
      resolvedBy: s('resolved_by'),
      resolution: r.resolution as Alert['resolution'],
      resolutionNote: s('resolution_note'),
      assigneeId: s('assignee_id'),
      assignedAt: iso(r.assigned_at as Date | null),
      inProgressAt: iso(r.in_progress_at as Date | null),
      resolutionCode: r.resolution_code as Alert['resolutionCode'],
      // rows created before 4.8 have no SLA: derive from first_raised_at in the view layer
      slaDueAt: iso(r.sla_due_at as Date | null) ?? isoRequired(r.first_raised_at as Date),
    };
  }

  private async rows(sql: string, params: unknown[]): Promise<Alert[]> {
    const res = await this.pool.query<Record<string, unknown>>(sql, params);
    return res.rows.map((r) => PgAlertStore.row(r));
  }

  async create(alert: Alert): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO alerts (${PgAlertStore.COLUMNS}) VALUES (${PgAlertStore.PLACEHOLDERS})
       ON CONFLICT (dedupe_key) WHERE status <> 'resolved' DO NOTHING RETURNING id`,
      PgAlertStore.params(alert),
    );
    return (res.rowCount ?? 0) > 0;
  }

  async save(alert: Alert): Promise<void> {
    const cols = PgAlertStore.COLUMNS.split(',').map((c) => c.trim());
    const updates = cols
      .filter((c) => c !== 'id')
      .map((c) => `${c} = EXCLUDED.${c}`)
      .join(', ');
    await this.pool.query(
      `INSERT INTO alerts (${PgAlertStore.COLUMNS}) VALUES (${PgAlertStore.PLACEHOLDERS})
       ON CONFLICT (id) DO UPDATE SET ${updates}`,
      PgAlertStore.params(alert),
    );
  }

  async get(id: string): Promise<Alert | undefined> {
    if (!isUuid(id)) return undefined;
    return (await this.rows(`SELECT ${PgAlertStore.COLUMNS} FROM alerts WHERE id = $1`, [id]))[0];
  }

  async findActive(dedupeKey: string): Promise<Alert | undefined> {
    return (
      await this.rows(
        `SELECT ${PgAlertStore.COLUMNS} FROM alerts WHERE dedupe_key = $1 AND status <> 'resolved'`,
        [dedupeKey],
      )
    )[0];
  }

  async list(q: AlertQuery): Promise<Alert[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown): void => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.status) add('status = ?', q.status);
    if (q.severity) add('severity = ?', q.severity);
    if (q.rule) add('rule = ?', q.rule);
    if (q.classroomId) add('classroom_id::text = ?', q.classroomId);
    if (q.deviceId) add('device_id::text = ?', q.deviceId);
    if (q.institutionId) add('institution_id::text = ?', q.institutionId);
    params.push(q.limit);
    return this.rows(
      `SELECT ${PgAlertStore.COLUMNS} FROM alerts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY (status = 'resolved'), severity DESC, last_seen_at DESC LIMIT $${params.length}`,
      params,
    );
  }

  async listActive(): Promise<Alert[]> {
    return this.rows(`SELECT ${PgAlertStore.COLUMNS} FROM alerts WHERE status <> 'resolved'`, []);
  }

  async query(f: IncidentFilter): Promise<Alert[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown): void => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (f.institutionId) add('institution_id::text = ?', f.institutionId);
    if (f.status) add('status = ?', f.status);
    if (f.severity) add('severity = ?', f.severity);
    if (f.rule) add('rule = ?', f.rule);
    if (f.campusId) add('campus_id::text = ?', f.campusId);
    if (f.assignee === 'unassigned') where.push('assignee_id IS NULL');
    else if (f.assignee) add('assignee_id = ?', f.assignee);
    if (f.raisedFrom) add('first_raised_at >= ?', f.raisedFrom);
    if (f.raisedTo) add('first_raised_at < ?', f.raisedTo);
    return this.rows(
      `SELECT ${PgAlertStore.COLUMNS} FROM alerts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
      params,
    );
  }

  async addDelivery(d: Delivery): Promise<void> {
    await this.pool.query(
      `INSERT INTO alert_deliveries (alert_id, channel, recipient, status, error, attempted_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [d.alertId, d.channel, d.recipient, d.status, d.error, d.attemptedAt],
    );
  }

  async deliveries(alertId: string): Promise<Delivery[]> {
    if (!isUuid(alertId)) return [];
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT alert_id, channel, recipient, status, error, attempted_at FROM alert_deliveries
       WHERE alert_id = $1 ORDER BY attempted_at, seq`,
      [alertId],
    );
    return res.rows.map((r) => ({
      alertId: String(r.alert_id),
      channel: String(r.channel),
      recipient: String(r.recipient),
      status: r.status as Delivery['status'],
      error: r.error === null ? null : String(r.error),
      attemptedAt: isoRequired(r.attempted_at as Date),
    }));
  }

  async markClass(scheduledClassId: string, mark: ClassMark): Promise<void> {
    if (!isUuid(scheduledClassId)) return;
    await this.pool.query(
      `INSERT INTO alert_class_marks (scheduled_class_id, mark, at) VALUES ($1, $2, NOW())
       ON CONFLICT (scheduled_class_id, mark) DO NOTHING`,
      [scheduledClassId, mark],
    );
  }

  async hasClassMark(scheduledClassId: string, mark: ClassMark): Promise<boolean> {
    if (!isUuid(scheduledClassId)) return false;
    const res = await this.pool.query(
      'SELECT 1 FROM alert_class_marks WHERE scheduled_class_id = $1 AND mark = $2',
      [scheduledClassId, mark],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async addComment(c: IncidentComment): Promise<void> {
    await this.pool.query(
      `INSERT INTO incident_comments (id, alert_id, actor_id, body, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [c.id, c.alertId, c.actorId, c.body, c.createdAt],
    );
  }

  async comments(alertId: string): Promise<IncidentComment[]> {
    if (!isUuid(alertId)) return [];
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT id, alert_id, actor_id, body, created_at FROM incident_comments
       WHERE alert_id = $1 ORDER BY created_at, seq`,
      [alertId],
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      alertId: String(r.alert_id),
      actorId: String(r.actor_id ?? ''),
      body: String(r.body),
      createdAt: isoRequired(r.created_at as Date),
    }));
  }

  async addActivity(e: IncidentActivity): Promise<void> {
    await this.pool.query(
      `INSERT INTO incident_activity (alert_id, at, action, actor_id, detail) VALUES ($1, $2, $3, $4, $5)`,
      [
        e.alertId,
        e.at,
        e.action,
        e.actorId,
        JSON.stringify(e.detail === null ? {} : { text: e.detail }),
      ],
    );
  }

  async activity(alertId: string): Promise<IncidentActivity[]> {
    if (!isUuid(alertId)) return [];
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT alert_id, at, action, actor_id, detail FROM incident_activity
       WHERE alert_id = $1 ORDER BY at, seq`,
      [alertId],
    );
    return res.rows.map((r) => {
      const detail = r.detail as { text?: unknown } | null;
      return {
        alertId: String(r.alert_id),
        at: isoRequired(r.at as Date),
        action: String(r.action),
        actorId: r.actor_id === null ? null : String(r.actor_id),
        detail: typeof detail?.text === 'string' ? detail.text : null,
      };
    });
  }

  async markEventProcessed(eventId: string, type: string): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO notification_processed_events (event_id, event_type) VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [eventId, type],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async isEventProcessed(eventId: string): Promise<boolean> {
    const res = await this.pool.query(
      'SELECT 1 FROM notification_processed_events WHERE event_id = $1',
      [eventId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
