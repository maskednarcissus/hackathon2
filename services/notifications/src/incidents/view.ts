import {
  SEVERITY_RANK,
  slaBreached,
  type Alert,
  type IncidentActivity,
  type IncidentComment,
  type Severity,
} from '../domain.js';

/** Incident = alert seen through the queue (Phase 4 §4). Shape consumed by administration-web. */
export interface IncidentView {
  id: string;
  type: Alert['rule'];
  rule: Alert['rule'];
  severity: Severity;
  status: Alert['status'];
  title: string;
  message: string;
  resourceType: Alert['resourceType'];
  resourceId: string;
  institutionId: string | null;
  deviceId: string | null;
  classroomId: string | null;
  classroomName: string | null;
  campusId: string | null;
  campusName: string | null;
  scheduledClassId: string | null;
  recordingSessionId: string | null;
  assigneeId: string | null;
  assignedAt: string | null;
  openedAt: string;
  lastSeenAt: string;
  occurrences: number;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  inProgressAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: Alert['resolution'];
  resolutionCode: Alert['resolutionCode'];
  resolutionNote: string | null;
  slaDueAt: string;
  slaBreached: boolean;
  ageMinutes: number;
  details: Record<string, unknown>;
}

export interface IncidentDetailView extends IncidentView {
  comments: { id: string; actorId: string; body: string; createdAt: string }[];
  timeline: { at: string; action: string; actorId: string | null; detail: string | null }[];
}

export function toIncident(a: Alert, now: Date): IncidentView {
  const end = a.resolvedAt ? new Date(a.resolvedAt) : now;
  return {
    id: a.id,
    type: a.rule,
    rule: a.rule,
    severity: a.severity,
    status: a.status,
    title: a.title,
    message: a.message,
    resourceType: a.resourceType,
    resourceId: a.resourceId,
    institutionId: a.institutionId,
    deviceId: a.deviceId,
    classroomId: a.classroomId,
    classroomName: a.classroomName ?? null,
    campusId: a.campusId ?? null,
    campusName: a.campusName ?? null,
    scheduledClassId: a.scheduledClassId,
    recordingSessionId: a.recordingSessionId,
    assigneeId: a.assigneeId ?? null,
    assignedAt: a.assignedAt ?? null,
    openedAt: a.firstRaisedAt,
    lastSeenAt: a.lastSeenAt,
    occurrences: a.occurrences,
    acknowledgedAt: a.acknowledgedAt,
    acknowledgedBy: a.acknowledgedBy,
    inProgressAt: a.inProgressAt ?? null,
    resolvedAt: a.resolvedAt,
    resolvedBy: a.resolvedBy,
    resolution: a.resolution,
    resolutionCode: a.resolutionCode ?? null,
    resolutionNote: a.resolutionNote,
    slaDueAt: a.slaDueAt,
    slaBreached: slaBreached(a, now),
    ageMinutes: Math.max(
      0,
      Math.floor((end.getTime() - new Date(a.firstRaisedAt).getTime()) / 60_000),
    ),
    details: a.details,
  };
}

export function toIncidentDetail(
  a: Alert,
  comments: IncidentComment[],
  activity: IncidentActivity[],
  now: Date,
): IncidentDetailView {
  return {
    ...toIncident(a, now),
    comments: comments
      .map(({ id, actorId, body, createdAt }) => ({ id, actorId, body, createdAt }))
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt)),
    timeline: activity
      .map(({ at, action, actorId, detail }) => ({ at, action, actorId, detail }))
      .sort((x, y) => x.at.localeCompare(y.at)),
  };
}

/**
 * `severity`: unresolved first, then severity desc, then SLA due soonest, then oldest.
 * `age`: oldest first (unresolved first).
 */
export function sortIncidents(items: IncidentView[], sort: 'severity' | 'age'): IncidentView[] {
  const unresolved = (i: IncidentView): number => (i.status === 'resolved' ? 1 : 0);
  return [...items].sort(
    (a, b) =>
      unresolved(a) - unresolved(b) ||
      (sort === 'severity'
        ? SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
          a.slaDueAt.localeCompare(b.slaDueAt)
        : 0) ||
      a.openedAt.localeCompare(b.openedAt) ||
      a.id.localeCompare(b.id),
  );
}

export interface IncidentStats {
  institutionId: string | null;
  from: string;
  to: string;
  /** Mean time to acknowledge (raised → acknowledged/in_progress), incidents raised in range. */
  mttaMinutes: number | null;
  /** Mean time to resolve (raised → resolved), incidents raised in range and resolved. */
  mttrMinutes: number | null;
  /** Current snapshot (not range-bound). */
  openBySeverity: Record<Severity, number>;
  openTotal: number;
  /** Incidents raised in range whose SLA is breached (resolved late, or overdue now). */
  slaBreaches: number;
  raised: number;
  resolved: number;
  byType: Record<string, number>;
}

const mean = (values: number[]): number | null =>
  values.length ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10 : null;

const minutesBetween = (a: string, b: string): number =>
  (new Date(b).getTime() - new Date(a).getTime()) / 60_000;

export function computeStats(
  inRange: Alert[],
  currentlyOpen: Alert[],
  range: { institutionId: string | null; from: string; to: string },
  now: Date,
): IncidentStats {
  const openBySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const a of currentlyOpen) openBySeverity[a.severity] += 1;
  const byType: Record<string, number> = {};
  for (const a of inRange) byType[a.rule] = (byType[a.rule] ?? 0) + 1;
  return {
    ...range,
    mttaMinutes: mean(
      inRange
        .filter((a) => a.acknowledgedAt)
        .map((a) => minutesBetween(a.firstRaisedAt, a.acknowledgedAt!)),
    ),
    mttrMinutes: mean(
      inRange
        .filter((a) => a.resolvedAt)
        .map((a) => minutesBetween(a.firstRaisedAt, a.resolvedAt!)),
    ),
    openBySeverity,
    openTotal: currentlyOpen.length,
    slaBreaches: inRange.filter((a) => slaBreached(a, now)).length,
    raised: inRange.length,
    resolved: inRange.filter((a) => a.status === 'resolved').length,
    byType,
  };
}
