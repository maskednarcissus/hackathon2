import type { Alert, Delivery, IncidentActivity, IncidentComment, Severity } from './domain.js';
import { SEVERITY_RANK } from './domain.js';
import type { AlertQuery } from './schemas.js';

/** Persistence port. Postgres adapter: tables `alerts` + `alert_deliveries` (see README). */
export type ClassMark = 'recording_started' | 'uploaded';

export interface IncidentFilter {
  institutionId?: string | undefined;
  status?: Alert['status'] | undefined;
  severity?: Severity | undefined;
  rule?: Alert['rule'] | undefined;
  campusId?: string | undefined;
  /** user id, or `unassigned` */
  assignee?: string | undefined;
  /** firstRaisedAt range (inclusive from, exclusive to) */
  raisedFrom?: string | undefined;
  raisedTo?: string | undefined;
}

export interface AlertStore {
  /** Filtered scan; the SQL adapter pushes these predicates into WHERE clauses. */
  query(filter: IncidentFilter): Promise<Alert[]>;
  addComment(comment: IncidentComment): Promise<void>;
  comments(alertId: string): Promise<IncidentComment[]>;
  addActivity(entry: IncidentActivity): Promise<void>;
  activity(alertId: string): Promise<IncidentActivity[]>;
  /** Remembers that a scheduled class had a recording start / upload (survives restarts). */
  markClass(scheduledClassId: string, mark: ClassMark): Promise<void>;
  hasClassMark(scheduledClassId: string, mark: ClassMark): Promise<boolean>;
  get(id: string): Promise<Alert | undefined>;
  findActive(dedupeKey: string): Promise<Alert | undefined>;
  save(alert: Alert): Promise<void>;
  list(query: AlertQuery): Promise<Alert[]>;
  listActive(): Promise<Alert[]>;
  addDelivery(delivery: Delivery): Promise<void>;
  deliveries(alertId: string): Promise<Delivery[]>;
}

export class InMemoryAlertStore implements AlertStore {
  private readonly alerts = new Map<string, Alert>();
  private readonly deliveryLog: Delivery[] = [];
  private readonly classMarks = new Set<string>();
  private readonly commentLog: IncidentComment[] = [];
  private readonly activityLog: IncidentActivity[] = [];

  query(f: IncidentFilter): Promise<Alert[]> {
    return Promise.resolve(
      [...this.alerts.values()]
        .filter(
          (a) =>
            (!f.institutionId || a.institutionId === f.institutionId) &&
            (!f.status || a.status === f.status) &&
            (!f.severity || a.severity === f.severity) &&
            (!f.rule || a.rule === f.rule) &&
            (!f.campusId || a.campusId === f.campusId) &&
            (!f.assignee ||
              (f.assignee === 'unassigned'
                ? a.assigneeId === null
                : a.assigneeId === f.assignee)) &&
            (!f.raisedFrom || a.firstRaisedAt >= f.raisedFrom) &&
            (!f.raisedTo || a.firstRaisedAt < f.raisedTo),
        )
        .map((a) => structuredClone(a)),
    );
  }

  addComment(comment: IncidentComment): Promise<void> {
    this.commentLog.push({ ...comment });
    return Promise.resolve();
  }

  comments(alertId: string): Promise<IncidentComment[]> {
    return Promise.resolve(
      this.commentLog.filter((c) => c.alertId === alertId).map((c) => ({ ...c })),
    );
  }

  addActivity(entry: IncidentActivity): Promise<void> {
    this.activityLog.push({ ...entry });
    return Promise.resolve();
  }

  activity(alertId: string): Promise<IncidentActivity[]> {
    return Promise.resolve(
      this.activityLog.filter((a) => a.alertId === alertId).map((a) => ({ ...a })),
    );
  }

  markClass(scheduledClassId: string, mark: ClassMark): Promise<void> {
    this.classMarks.add(`${mark}:${scheduledClassId}`);
    return Promise.resolve();
  }

  hasClassMark(scheduledClassId: string, mark: ClassMark): Promise<boolean> {
    return Promise.resolve(this.classMarks.has(`${mark}:${scheduledClassId}`));
  }

  get(id: string): Promise<Alert | undefined> {
    const alert = this.alerts.get(id);
    return Promise.resolve(alert ? structuredClone(alert) : undefined);
  }

  findActive(dedupeKey: string): Promise<Alert | undefined> {
    for (const alert of this.alerts.values()) {
      if (alert.dedupeKey === dedupeKey && alert.status !== 'resolved') {
        return Promise.resolve(structuredClone(alert));
      }
    }
    return Promise.resolve(undefined);
  }

  save(alert: Alert): Promise<void> {
    this.alerts.set(alert.id, structuredClone(alert));
    return Promise.resolve();
  }

  list(query: AlertQuery): Promise<Alert[]> {
    const result = [...this.alerts.values()]
      .filter(
        (a) =>
          (!query.status || a.status === query.status) &&
          (!query.severity || a.severity === query.severity) &&
          (!query.rule || a.rule === query.rule) &&
          (!query.classroomId || a.classroomId === query.classroomId) &&
          (!query.deviceId || a.deviceId === query.deviceId) &&
          (!query.institutionId || a.institutionId === query.institutionId),
      )
      .sort(
        (a, b) =>
          Number(a.status === 'resolved') - Number(b.status === 'resolved') ||
          SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
          b.lastSeenAt.localeCompare(a.lastSeenAt),
      )
      .slice(0, query.limit);
    return Promise.resolve(result.map((a) => structuredClone(a)));
  }

  listActive(): Promise<Alert[]> {
    return Promise.resolve(
      [...this.alerts.values()]
        .filter((a) => a.status !== 'resolved')
        .map((a) => structuredClone(a)),
    );
  }

  addDelivery(delivery: Delivery): Promise<void> {
    this.deliveryLog.push({ ...delivery });
    return Promise.resolve();
  }

  deliveries(alertId: string): Promise<Delivery[]> {
    return Promise.resolve(this.deliveryLog.filter((d) => d.alertId === alertId));
  }
}
