import type {
  DeferredDelivery,
  EnrollmentRecord,
  NotificationPreferences,
  PushSubscriptionRecord,
  StudentDelivery,
  TrackedEvent,
  UserNotification,
} from './types.js';

/**
 * Persistence port for student notifications. Postgres tables:
 * `user_notifications` (unique dedupe_key), `notification_preferences`, `push_subscriptions`
 * (unique (user_id, endpoint)), `deferred_deliveries`, `notification_deliveries`,
 * `notification_enrollments` (mirror), `notification_tracked_events`.
 */
export interface UserDataExport {
  notifications: UserNotification[];
  preferences: NotificationPreferences | null;
  pushSubscriptions: Omit<PushSubscriptionRecord, 'keys'>[];
  enrollments: EnrollmentRecord[];
}

export interface UserDataDeletion {
  notifications: number;
  preferences: number;
  pushSubscriptions: number;
  /** enrollment mirror rows whose e-mail was erased (rows stay: they are academic data) */
  enrollmentsAnonymized: number;
}

export interface StudentStore {
  // ---- data subject rights (integration stage §5) ----
  findUserIdsByStudent(studentId: string): Promise<string[]>;
  exportUserData(userId: string): Promise<UserDataExport>;
  /** Removes inbox (and its deliveries / deferred items), preferences and push subscriptions. */
  deleteUserData(userId: string): Promise<UserDataDeletion>;

  /** Inserts unless the dedupe key exists. Returns false on duplicate (atomic in SQL: ON CONFLICT DO NOTHING). */
  insertNotification(n: UserNotification): Promise<boolean>;
  getNotification(id: string): Promise<UserNotification | undefined>;
  listNotifications(
    userId: string,
    opts: { unread?: boolean; limit: number; before?: string },
  ): Promise<UserNotification[]>;
  countUnread(userId: string): Promise<number>;
  markRead(userId: string, id: string, at: string): Promise<UserNotification | undefined>;
  markAllRead(userId: string, at: string): Promise<number>;

  getPreferences(userId: string): Promise<NotificationPreferences | undefined>;
  savePreferences(p: NotificationPreferences): Promise<void>;

  upsertPushSubscription(s: PushSubscriptionRecord): Promise<PushSubscriptionRecord>;
  listPushSubscriptions(userId: string): Promise<PushSubscriptionRecord[]>;
  deletePushSubscription(userId: string, id: string): Promise<boolean>;
  updatePushSubscription(s: PushSubscriptionRecord): Promise<void>;

  addDeferred(d: DeferredDelivery): Promise<void>;
  takeDueDeferred(now: string, limit: number): Promise<DeferredDelivery[]>;
  countDeferred(): Promise<number>;

  addDelivery(d: StudentDelivery): Promise<void>;
  deliveries(notificationId: string): Promise<StudentDelivery[]>;

  upsertEnrollment(e: EnrollmentRecord): Promise<void>;
  listEnrollments(classSectionId: string): Promise<EnrollmentRecord[]>;

  getTrackedEvent(calendarEventId: string): Promise<TrackedEvent | undefined>;
  findTrackedByExtracted(extractedEventId: string): Promise<TrackedEvent | undefined>;
  saveTrackedEvent(e: TrackedEvent): Promise<void>;
  listTrackedEvents(filter: {
    status: 'active';
    fromDate: string;
    toDate: string;
  }): Promise<TrackedEvent[]>;
}

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryStudentStore implements StudentStore {
  private readonly notifications = new Map<string, UserNotification>();
  private readonly dedupe = new Set<string>();
  private readonly prefs = new Map<string, NotificationPreferences>();
  private readonly subs = new Map<string, PushSubscriptionRecord>();
  private deferred: DeferredDelivery[] = [];
  private readonly deliveryLog: StudentDelivery[] = [];
  private readonly enrollments = new Map<string, EnrollmentRecord>();
  private readonly tracked = new Map<string, TrackedEvent>();

  findUserIdsByStudent(studentId: string): Promise<string[]> {
    return Promise.resolve([
      ...new Set(
        [...this.enrollments.values()]
          .filter((e) => e.studentId === studentId)
          .map((e) => e.userId),
      ),
    ]);
  }

  exportUserData(userId: string): Promise<UserDataExport> {
    return Promise.resolve({
      notifications: [...this.notifications.values()]
        .filter((n) => n.userId === userId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(clone),
      preferences: this.prefs.has(userId) ? clone(this.prefs.get(userId)!) : null,
      pushSubscriptions: [...this.subs.values()]
        .filter((s) => s.userId === userId)
        .map(({ keys: _keys, ...rest }) => clone(rest)),
      enrollments: [...this.enrollments.values()].filter((e) => e.userId === userId).map(clone),
    });
  }

  deleteUserData(userId: string): Promise<UserDataDeletion> {
    const ids = new Set(
      [...this.notifications.values()].filter((n) => n.userId === userId).map((n) => n.id),
    );
    for (const id of ids) {
      const n = this.notifications.get(id)!;
      this.dedupe.delete(n.dedupeKey);
      this.notifications.delete(id);
    }
    this.deferred = this.deferred.filter((d) => !ids.has(d.notificationId));
    for (let i = this.deliveryLog.length - 1; i >= 0; i -= 1) {
      if (ids.has(this.deliveryLog[i]!.notificationId)) this.deliveryLog.splice(i, 1);
    }
    const preferences = this.prefs.delete(userId) ? 1 : 0;
    let pushSubscriptions = 0;
    for (const [id, s] of this.subs) {
      if (s.userId === userId) {
        this.subs.delete(id);
        pushSubscriptions += 1;
      }
    }
    let enrollmentsAnonymized = 0;
    for (const e of this.enrollments.values()) {
      if (e.userId === userId && e.email !== null) {
        e.email = null;
        enrollmentsAnonymized += 1;
      }
    }
    return Promise.resolve({
      notifications: ids.size,
      preferences,
      pushSubscriptions,
      enrollmentsAnonymized,
    });
  }

  insertNotification(n: UserNotification): Promise<boolean> {
    if (this.dedupe.has(n.dedupeKey)) return Promise.resolve(false);
    this.dedupe.add(n.dedupeKey);
    this.notifications.set(n.id, clone(n));
    return Promise.resolve(true);
  }

  getNotification(id: string): Promise<UserNotification | undefined> {
    const n = this.notifications.get(id);
    return Promise.resolve(n ? clone(n) : undefined);
  }

  listNotifications(
    userId: string,
    opts: { unread?: boolean; limit: number; before?: string },
  ): Promise<UserNotification[]> {
    const list = [...this.notifications.values()]
      .filter(
        (n) =>
          n.userId === userId &&
          n.inApp &&
          (opts.unread === undefined || (opts.unread ? n.readAt === null : n.readAt !== null)) &&
          (!opts.before || n.createdAt < opts.before),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, opts.limit);
    return Promise.resolve(list.map(clone));
  }

  countUnread(userId: string): Promise<number> {
    return Promise.resolve(
      [...this.notifications.values()].filter(
        (n) => n.userId === userId && n.inApp && n.readAt === null,
      ).length,
    );
  }

  markRead(userId: string, id: string, at: string): Promise<UserNotification | undefined> {
    const n = this.notifications.get(id);
    if (!n || n.userId !== userId || !n.inApp) return Promise.resolve(undefined);
    if (n.readAt === null) n.readAt = at;
    return Promise.resolve(clone(n));
  }

  markAllRead(userId: string, at: string): Promise<number> {
    let count = 0;
    for (const n of this.notifications.values()) {
      if (n.userId === userId && n.inApp && n.readAt === null) {
        n.readAt = at;
        count += 1;
      }
    }
    return Promise.resolve(count);
  }

  getPreferences(userId: string): Promise<NotificationPreferences | undefined> {
    const p = this.prefs.get(userId);
    return Promise.resolve(p ? clone(p) : undefined);
  }

  savePreferences(p: NotificationPreferences): Promise<void> {
    this.prefs.set(p.userId, clone(p));
    return Promise.resolve();
  }

  upsertPushSubscription(s: PushSubscriptionRecord): Promise<PushSubscriptionRecord> {
    for (const existing of this.subs.values()) {
      if (existing.userId === s.userId && existing.endpoint === s.endpoint) {
        const merged = { ...existing, keys: s.keys, userAgent: s.userAgent, failureCount: 0 };
        this.subs.set(existing.id, merged);
        return Promise.resolve(clone(merged));
      }
    }
    this.subs.set(s.id, clone(s));
    return Promise.resolve(clone(s));
  }

  listPushSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
    return Promise.resolve([...this.subs.values()].filter((s) => s.userId === userId).map(clone));
  }

  deletePushSubscription(userId: string, id: string): Promise<boolean> {
    const s = this.subs.get(id);
    if (!s || s.userId !== userId) return Promise.resolve(false);
    this.subs.delete(id);
    return Promise.resolve(true);
  }

  updatePushSubscription(s: PushSubscriptionRecord): Promise<void> {
    if (this.subs.has(s.id)) this.subs.set(s.id, clone(s));
    return Promise.resolve();
  }

  addDeferred(d: DeferredDelivery): Promise<void> {
    this.deferred.push(clone(d));
    return Promise.resolve();
  }

  takeDueDeferred(now: string, limit: number): Promise<DeferredDelivery[]> {
    const due = this.deferred
      .filter((d) => d.dueAt <= now)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
      .slice(0, limit);
    const ids = new Set(due.map((d) => d.id));
    this.deferred = this.deferred.filter((d) => !ids.has(d.id));
    return Promise.resolve(due);
  }

  countDeferred(): Promise<number> {
    return Promise.resolve(this.deferred.length);
  }

  addDelivery(d: StudentDelivery): Promise<void> {
    this.deliveryLog.push(clone(d));
    return Promise.resolve();
  }

  deliveries(notificationId: string): Promise<StudentDelivery[]> {
    return Promise.resolve(
      this.deliveryLog.filter((d) => d.notificationId === notificationId).map(clone),
    );
  }

  upsertEnrollment(e: EnrollmentRecord): Promise<void> {
    this.enrollments.set(`${e.userId}|${e.classSectionId}`, clone(e));
    return Promise.resolve();
  }

  listEnrollments(classSectionId: string): Promise<EnrollmentRecord[]> {
    return Promise.resolve(
      [...this.enrollments.values()].filter((e) => e.classSectionId === classSectionId).map(clone),
    );
  }

  getTrackedEvent(calendarEventId: string): Promise<TrackedEvent | undefined> {
    const e = this.tracked.get(calendarEventId);
    return Promise.resolve(e ? clone(e) : undefined);
  }

  findTrackedByExtracted(extractedEventId: string): Promise<TrackedEvent | undefined> {
    const e = [...this.tracked.values()].find((t) => t.extractedEventId === extractedEventId);
    return Promise.resolve(e ? clone(e) : undefined);
  }

  saveTrackedEvent(e: TrackedEvent): Promise<void> {
    this.tracked.set(e.calendarEventId, clone(e));
    return Promise.resolve();
  }

  listTrackedEvents(filter: {
    status: 'active';
    fromDate: string;
    toDate: string;
  }): Promise<TrackedEvent[]> {
    return Promise.resolve(
      [...this.tracked.values()]
        .filter(
          (e) =>
            e.status === filter.status &&
            e.eventDate >= filter.fromDate &&
            e.eventDate <= filter.toDate,
        )
        .map(clone),
    );
  }
}
