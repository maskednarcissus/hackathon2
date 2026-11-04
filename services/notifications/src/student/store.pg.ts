import type pg from 'pg';
import { iso, isoRequired, isUuid, withTransaction } from '../db.js';
import { notificationLink } from './links.js';
import { defaultPreferences } from './preferences.js';
import type { StudentStore, UserDataDeletion, UserDataExport } from './store.js';
import type {
  Category,
  ChannelToggles,
  DeferredDelivery,
  EnrollmentRecord,
  NotificationPreferences,
  PushSubscriptionRecord,
  StudentDelivery,
  TrackedEvent,
  UserNotification,
} from './types.js';

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const NOTIFICATION_COLUMNS = `id, user_id, institution_id, category, title, body, link, resource_type,
  resource_id, version, dedupe_key, data, in_app, created_at, read_at`;

function notificationRow(r: Row): UserNotification {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    institutionId: str(r.institution_id),
    category: r.category as Category,
    title: String(r.title),
    body: String(r.body),
    resourceType: r.resource_type as UserNotification['resourceType'],
    resourceId: String(r.resource_id),
    version: String(r.version),
    dedupeKey: String(r.dedupe_key),
    data: (r.data ?? {}) as Record<string, unknown>,
    inApp: Boolean(r.in_app),
    createdAt: isoRequired(r.created_at as Date),
    readAt: iso(r.read_at as Date | null),
  };
}

function subscriptionRow(r: Row): PushSubscriptionRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    endpoint: String(r.endpoint),
    keys: { p256dh: String(r.p256dh), auth: String(r.auth) },
    userAgent: str(r.user_agent),
    createdAt: isoRequired(r.created_at as Date),
    lastSuccessAt: iso(r.last_success_at as Date | null),
    failureCount: Number(r.failure_count),
  };
}

function enrollmentRow(r: Row): EnrollmentRecord {
  return {
    userId: String(r.user_id),
    studentId: String(r.student_id),
    institutionId: String(r.institution_id),
    classSectionId: String(r.class_section_id),
    email: str(r.email),
    status: r.status as EnrollmentRecord['status'],
    syncedAt: isoRequired(r.synced_at as Date),
  };
}

function trackedRow(r: Row): TrackedEvent {
  return {
    calendarEventId: String(r.calendar_event_id),
    extractedEventId: str(r.extracted_event_id),
    institutionId: str(r.institution_id),
    classSectionId: String(r.class_section_id),
    courseId: str(r.course_id),
    type: String(r.event_type),
    title: String(r.title),
    eventDate: String(r.event_date),
    eventTime: r.event_time === null ? null : String(r.event_time).slice(0, 5),
    timezone: String(r.timezone),
    status: r.status as TrackedEvent['status'],
    version: Number(r.version),
    updatedAt: isoRequired(r.updated_at as Date),
  };
}

function preferencesRow(r: Row): NotificationPreferences {
  const base = defaultPreferences(String(r.user_id));
  const stored = (r.categories ?? {}) as Partial<Record<Category, Partial<ChannelToggles>>>;
  for (const key of Object.keys(base.categories) as Category[]) {
    base.categories[key] = { ...base.categories[key], ...(stored[key] ?? {}) };
  }
  return {
    userId: String(r.user_id),
    categories: base.categories,
    quietHours:
      r.quiet_start !== null && r.quiet_end !== null && r.quiet_timezone !== null
        ? {
            start: String(r.quiet_start).slice(0, 5),
            end: String(r.quiet_end).slice(0, 5),
            timezone: String(r.quiet_timezone),
          }
        : null,
    reminderOffsetsHours: (r.reminder_offsets_hours as number[]).map(Number),
    updatedAt: iso(r.updated_at as Date | null),
  };
}

/** Postgres adapter for student notifications (V003 §8 + pending/notifications.sql). */
export class PgStudentStore implements StudentStore {
  constructor(private readonly pool: pg.Pool) {}

  // ------------------------------------------------------------------ inbox
  async insertNotification(n: UserNotification): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO user_notifications (${NOTIFICATION_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [
        n.id,
        n.userId,
        n.institutionId,
        n.category,
        n.title,
        n.body,
        notificationLink(n) ?? null,
        n.resourceType,
        n.resourceId,
        n.version,
        n.dedupeKey,
        JSON.stringify(n.data),
        n.inApp,
        n.createdAt,
        n.readAt,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async getNotification(id: string): Promise<UserNotification | undefined> {
    if (!isUuid(id)) return undefined;
    const res = await this.pool.query<Row>(
      `SELECT ${NOTIFICATION_COLUMNS} FROM user_notifications WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? notificationRow(res.rows[0]) : undefined;
  }

  async listNotifications(
    userId: string,
    opts: { unread?: boolean; limit: number; before?: string },
  ): Promise<UserNotification[]> {
    const params: unknown[] = [userId];
    let where = 'user_id = $1 AND in_app';
    if (opts.unread === true) where += ' AND read_at IS NULL';
    if (opts.unread === false) where += ' AND read_at IS NOT NULL';
    if (opts.before) {
      params.push(opts.before);
      where += ` AND created_at < $${params.length}`;
    }
    params.push(opts.limit);
    const res = await this.pool.query<Row>(
      `SELECT ${NOTIFICATION_COLUMNS} FROM user_notifications WHERE ${where}
       ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(notificationRow);
  }

  async countUnread(userId: string): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM user_notifications WHERE user_id = $1 AND in_app AND read_at IS NULL',
      [userId],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async markRead(userId: string, id: string, at: string): Promise<UserNotification | undefined> {
    if (!isUuid(id)) return undefined;
    const res = await this.pool.query<Row>(
      `UPDATE user_notifications SET read_at = COALESCE(read_at, $3)
       WHERE id = $2 AND user_id = $1 AND in_app RETURNING ${NOTIFICATION_COLUMNS}`,
      [userId, id, at],
    );
    return res.rows[0] ? notificationRow(res.rows[0]) : undefined;
  }

  async markAllRead(userId: string, at: string): Promise<number> {
    const res = await this.pool.query(
      'UPDATE user_notifications SET read_at = $2 WHERE user_id = $1 AND in_app AND read_at IS NULL',
      [userId, at],
    );
    return res.rowCount ?? 0;
  }

  // ------------------------------------------------------------------ preferences
  async getPreferences(userId: string): Promise<NotificationPreferences | undefined> {
    const res = await this.pool.query<Row>(
      'SELECT * FROM notification_preferences WHERE user_id = $1',
      [userId],
    );
    return res.rows[0] ? preferencesRow(res.rows[0]) : undefined;
  }

  async savePreferences(p: NotificationPreferences): Promise<void> {
    await this.pool.query(
      `INSERT INTO notification_preferences
         (user_id, categories, quiet_start, quiet_end, quiet_timezone, reminder_offsets_hours, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))
       ON CONFLICT (user_id) DO UPDATE SET categories = EXCLUDED.categories,
         quiet_start = EXCLUDED.quiet_start, quiet_end = EXCLUDED.quiet_end,
         quiet_timezone = EXCLUDED.quiet_timezone,
         reminder_offsets_hours = EXCLUDED.reminder_offsets_hours, updated_at = EXCLUDED.updated_at`,
      [
        p.userId,
        JSON.stringify(p.categories),
        p.quietHours?.start ?? null,
        p.quietHours?.end ?? null,
        p.quietHours?.timezone ?? null,
        p.reminderOffsetsHours,
        p.updatedAt,
      ],
    );
  }

  // ------------------------------------------------------------------ push
  async upsertPushSubscription(s: PushSubscriptionRecord): Promise<PushSubscriptionRecord> {
    const res = await this.pool.query<Row>(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
         user_agent = EXCLUDED.user_agent, failure_count = 0
       RETURNING *`,
      [s.id, s.userId, s.endpoint, s.keys.p256dh, s.keys.auth, s.userAgent, s.createdAt],
    );
    return subscriptionRow(res.rows[0]!);
  }

  async listPushSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
    const res = await this.pool.query<Row>(
      'SELECT * FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at, id',
      [userId],
    );
    return res.rows.map(subscriptionRow);
  }

  async deletePushSubscription(userId: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const res = await this.pool.query(
      'DELETE FROM push_subscriptions WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async updatePushSubscription(s: PushSubscriptionRecord): Promise<void> {
    await this.pool.query(
      'UPDATE push_subscriptions SET last_success_at = $2, failure_count = $3 WHERE id = $1',
      [s.id, s.lastSuccessAt, s.failureCount],
    );
  }

  // ------------------------------------------------------------------ deliveries / deferred
  async addDeferred(d: DeferredDelivery): Promise<void> {
    await this.pool.query(
      `INSERT INTO notification_deliveries (id, notification_id, channel, status, detail, due_at, attempted_at)
       VALUES ($1, $2, $3, 'deferred', $4, $5, $6)`,
      [d.id, d.notificationId, d.channel, `quiet hours until ${d.dueAt}`, d.dueAt, d.createdAt],
    );
  }

  /** Claims due deferred rows atomically (`FOR UPDATE SKIP LOCKED`), so concurrent flushers never double-send. */
  async takeDueDeferred(now: string, limit: number): Promise<DeferredDelivery[]> {
    const res = await this.pool.query<Row>(
      `WITH due AS (
         SELECT id FROM notification_deliveries
         WHERE status = 'deferred' AND due_at <= $1
         ORDER BY due_at LIMIT $2 FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE notification_deliveries d SET status = 'released'
         FROM due WHERE d.id = due.id
         RETURNING d.id, d.notification_id, d.channel, d.due_at, d.attempted_at
       )
       SELECT c.*, n.user_id FROM claimed c JOIN user_notifications n ON n.id = c.notification_id`,
      [now, limit],
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      notificationId: String(r.notification_id),
      userId: String(r.user_id),
      channel: r.channel as DeferredDelivery['channel'],
      dueAt: isoRequired(r.due_at as Date),
      createdAt: isoRequired(r.attempted_at as Date),
    }));
  }

  async countDeferred(): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM notification_deliveries WHERE status = 'deferred'",
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async addDelivery(d: StudentDelivery): Promise<void> {
    // a deferred delivery is already represented by the row written in addDeferred()
    if (d.status === 'deferred') return;
    await this.pool.query(
      `INSERT INTO notification_deliveries (notification_id, channel, status, detail, attempted_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [d.notificationId, d.channel, d.status, d.detail, d.attemptedAt],
    );
  }

  async deliveries(notificationId: string): Promise<StudentDelivery[]> {
    if (!isUuid(notificationId)) return [];
    const res = await this.pool.query<Row>(
      `SELECT d.notification_id, d.channel, d.status, d.detail, d.attempted_at, n.user_id
       FROM notification_deliveries d JOIN user_notifications n ON n.id = d.notification_id
       WHERE d.notification_id = $1 ORDER BY d.attempted_at, d.seq`,
      [notificationId],
    );
    return res.rows.map((r) => ({
      notificationId: String(r.notification_id),
      userId: String(r.user_id),
      channel: r.channel as StudentDelivery['channel'],
      status: (r.status === 'released' ? 'deferred' : r.status) as StudentDelivery['status'],
      detail: str(r.detail),
      attemptedAt: isoRequired(r.attempted_at as Date),
    }));
  }

  // ------------------------------------------------------------------ enrollment mirror
  async upsertEnrollment(e: EnrollmentRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO notification_enrollments
         (user_id, student_id, institution_id, class_section_id, email, status, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, class_section_id) DO UPDATE SET student_id = EXCLUDED.student_id,
         institution_id = EXCLUDED.institution_id, email = EXCLUDED.email,
         status = EXCLUDED.status, synced_at = EXCLUDED.synced_at`,
      [e.userId, e.studentId, e.institutionId, e.classSectionId, e.email, e.status, e.syncedAt],
    );
  }

  async listEnrollments(classSectionId: string): Promise<EnrollmentRecord[]> {
    if (!isUuid(classSectionId)) return [];
    const res = await this.pool.query<Row>(
      'SELECT * FROM notification_enrollments WHERE class_section_id = $1',
      [classSectionId],
    );
    return res.rows.map(enrollmentRow);
  }

  // ------------------------------------------------------------------ tracked events
  async getTrackedEvent(calendarEventId: string): Promise<TrackedEvent | undefined> {
    if (!isUuid(calendarEventId)) return undefined;
    const res = await this.pool.query<Row>(
      'SELECT * FROM notification_tracked_events WHERE calendar_event_id = $1',
      [calendarEventId],
    );
    return res.rows[0] ? trackedRow(res.rows[0]) : undefined;
  }

  async findTrackedByExtracted(extractedEventId: string): Promise<TrackedEvent | undefined> {
    if (!isUuid(extractedEventId)) return undefined;
    const res = await this.pool.query<Row>(
      'SELECT * FROM notification_tracked_events WHERE extracted_event_id = $1 ORDER BY updated_at DESC LIMIT 1',
      [extractedEventId],
    );
    return res.rows[0] ? trackedRow(res.rows[0]) : undefined;
  }

  async saveTrackedEvent(e: TrackedEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO notification_tracked_events (calendar_event_id, extracted_event_id, institution_id,
         class_section_id, course_id, event_type, title, event_date, event_time, timezone, status, version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (calendar_event_id) DO UPDATE SET extracted_event_id = EXCLUDED.extracted_event_id,
         institution_id = EXCLUDED.institution_id, class_section_id = EXCLUDED.class_section_id,
         course_id = EXCLUDED.course_id, event_type = EXCLUDED.event_type, title = EXCLUDED.title,
         event_date = EXCLUDED.event_date, event_time = EXCLUDED.event_time, timezone = EXCLUDED.timezone,
         status = EXCLUDED.status, version = EXCLUDED.version, updated_at = EXCLUDED.updated_at`,
      [
        e.calendarEventId,
        isUuid(e.extractedEventId) ? e.extractedEventId : null,
        isUuid(e.institutionId) ? e.institutionId : null,
        e.classSectionId,
        isUuid(e.courseId) ? e.courseId : null,
        e.type,
        e.title,
        e.eventDate,
        e.eventTime,
        e.timezone,
        e.status,
        e.version,
        e.updatedAt,
      ],
    );
  }

  async listTrackedEvents(f: {
    status: 'active';
    fromDate: string;
    toDate: string;
  }): Promise<TrackedEvent[]> {
    const res = await this.pool.query<Row>(
      `SELECT * FROM notification_tracked_events
       WHERE status = $1 AND event_date BETWEEN $2 AND $3 ORDER BY event_date, event_time`,
      [f.status, f.fromDate, f.toDate],
    );
    return res.rows.map(trackedRow);
  }

  // ------------------------------------------------------------------ DSR
  async findUserIdsByStudent(studentId: string): Promise<string[]> {
    if (!isUuid(studentId)) return [];
    const res = await this.pool.query<{ user_id: string }>(
      'SELECT DISTINCT user_id FROM notification_enrollments WHERE student_id = $1',
      [studentId],
    );
    return res.rows.map((r) => r.user_id);
  }

  async exportUserData(userId: string): Promise<UserDataExport> {
    const [notifications, preferences, subs, enrollments] = await Promise.all([
      this.pool.query<Row>(
        `SELECT ${NOTIFICATION_COLUMNS} FROM user_notifications WHERE user_id = $1 ORDER BY created_at, id`,
        [userId],
      ),
      this.getPreferences(userId),
      this.listPushSubscriptions(userId),
      this.pool.query<Row>('SELECT * FROM notification_enrollments WHERE user_id = $1', [userId]),
    ]);
    return {
      notifications: notifications.rows.map(notificationRow),
      preferences: preferences ?? null,
      pushSubscriptions: subs.map(({ keys: _keys, ...rest }) => rest),
      enrollments: enrollments.rows.map(enrollmentRow),
    };
  }

  async deleteUserData(userId: string): Promise<UserDataDeletion> {
    return withTransaction(this.pool, async (client) => {
      // notification_deliveries (incl. deferred) cascade from user_notifications
      const n = await client.query('DELETE FROM user_notifications WHERE user_id = $1', [userId]);
      const p = await client.query('DELETE FROM notification_preferences WHERE user_id = $1', [
        userId,
      ]);
      const s = await client.query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]);
      const e = await client.query(
        'UPDATE notification_enrollments SET email = NULL WHERE user_id = $1 AND email IS NOT NULL',
        [userId],
      );
      return {
        notifications: n.rowCount ?? 0,
        preferences: p.rowCount ?? 0,
        pushSubscriptions: s.rowCount ?? 0,
        enrollmentsAnonymized: e.rowCount ?? 0,
      };
    });
  }
}
