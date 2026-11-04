import type { Alert, Delivery } from './domain.js';
import { SEVERITY_RANK } from './domain.js';
import type { AlertQuery } from './schemas.js';

/** Persistence port. Postgres adapter: tables `alerts` + `alert_deliveries` (see README). */
export type ClassMark = 'recording_started' | 'uploaded';

export interface AlertStore {
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
