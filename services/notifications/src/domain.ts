/** Alerting domain model — contract §10 (docs/architecture/phase-1-capture-pipeline.md). */

export const ALERT_RULES = [
  'device_offline',
  'recording_missed',
  'failed_upload',
  'poor_audio_quality',
  'transcription_failure',
  'low_storage',
] as const;
export type AlertRule = (typeof ALERT_RULES)[number];

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ALERT_STATUSES = ['open', 'acknowledged', 'in_progress', 'resolved'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export type ResourceType = 'device' | 'scheduled_class' | 'recording_session';

export const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Thresholds from contract §10. */
export const ALERT_POLICY = {
  offlineAfterMs: 3 * 60_000,
  offlineOutsideWindowAfterMs: 5 * 60_000,
  missedRecordingGraceMs: 5 * 60_000,
  uploadOverdueMs: 2 * 60 * 60_000,
  lowStorageBytes: 1024 ** 3,
  renotifyCooldownMs: 30 * 60_000,
} as const;

export interface Alert {
  id: string;
  rule: AlertRule;
  /** Dedupe key: `${rule}:${resourceId}` — at most one unresolved alert per key. */
  dedupeKey: string;
  resourceType: ResourceType;
  resourceId: string;
  institutionId: string | null;
  classroomId: string | null;
  /** Resolved from the classroom via the organization service (Phase 4 §4). */
  campusId: string | null;
  classroomName: string | null;
  campusName: string | null;
  deviceId: string | null;
  scheduledClassId: string | null;
  recordingSessionId: string | null;
  severity: Severity;
  status: AlertStatus;
  title: string;
  message: string;
  details: Record<string, unknown>;
  firstRaisedAt: string;
  lastSeenAt: string;
  lastNotifiedAt: string | null;
  notificationCount: number;
  occurrences: number;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: 'auto' | 'manual' | null;
  resolutionNote: string | null;
  // ---- incident queue (Phase 4 §4) ----
  assigneeId: string | null;
  assignedAt: string | null;
  inProgressAt: string | null;
  resolutionCode: ResolutionCode | null;
  /** firstRaisedAt + SLA(severity); recomputed on escalation. */
  slaDueAt: string;
}

export const RESOLUTION_CODES = [
  'hardware_replaced',
  'network_fixed',
  'configuration',
  'false_positive',
  'class_cancelled',
  'other',
] as const;
export type ResolutionCode = (typeof RESOLUTION_CODES)[number];

/** Time to resolve, by severity (Phase 4 §4). */
export const SLA_MS: Record<Severity, number> = {
  critical: 60 * 60_000,
  high: 4 * 60 * 60_000,
  medium: 24 * 60 * 60_000,
  low: 72 * 60 * 60_000,
};

export const slaDueAt = (firstRaisedAt: string, severity: Severity): string =>
  new Date(new Date(firstRaisedAt).getTime() + SLA_MS[severity]).toISOString();

/** Breached when resolved after the due time, or still unresolved past it. */
export const slaBreached = (alert: Pick<Alert, 'slaDueAt' | 'resolvedAt'>, now: Date): boolean =>
  alert.resolvedAt
    ? alert.resolvedAt > alert.slaDueAt
    : now.getTime() > new Date(alert.slaDueAt).getTime();

export interface IncidentComment {
  id: string;
  alertId: string;
  actorId: string;
  body: string;
  createdAt: string;
}

export interface IncidentActivity {
  alertId: string;
  at: string;
  action: string;
  actorId: string | null;
  detail: string | null;
}

/** A detected condition; the engine turns it into a new or updated alert. */
export interface AlertCondition {
  rule: AlertRule;
  resourceType: ResourceType;
  resourceId: string;
  severity: Severity;
  title: string;
  message: string;
  institutionId?: string | null | undefined;
  classroomId?: string | null | undefined;
  deviceId?: string | null | undefined;
  scheduledClassId?: string | null | undefined;
  recordingSessionId?: string | null | undefined;
  details?: Record<string, unknown> | undefined;
}

export interface Delivery {
  alertId: string;
  channel: string;
  recipient: string;
  status: 'sent' | 'failed';
  error: string | null;
  attemptedAt: string;
}

export const dedupeKey = (rule: AlertRule, resourceId: string): string => `${rule}:${resourceId}`;
