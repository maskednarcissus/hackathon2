/** notifications incident queue client (Phase 4 contract §4). Server-side only. */
import type { ApiResult } from './fleet';
import type { Open } from './open';
import { apiGet, apiRequest, institutionId, query } from './http';

export const INCIDENT_STATUSES = ['open', 'acknowledged', 'in_progress', 'resolved'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const RESOLUTION_CODES = [
  'hardware_replaced',
  'network_fixed',
  'configuration',
  'false_positive',
  'class_cancelled',
  'other',
] as const;
export type ResolutionCode = (typeof RESOLUTION_CODES)[number];

export const INCIDENT_TYPES = [
  'device_offline',
  'recording_missed',
  'failed_upload',
  'poor_audio_quality',
  'transcription_failure',
  'low_storage',
] as const;

export interface IncidentComment {
  id?: string;
  actorId: string;
  body: string;
  createdAt: string;
}

export interface IncidentTimelineEntry {
  at: string;
  action: string;
  actorId?: string | null;
  detail?: string | null;
}

export interface Incident {
  id: string;
  rule?: string;
  type: string;
  severity: Open<Severity>;
  status: Open<IncidentStatus>;
  title?: string;
  message?: string;
  resourceId?: string;
  deviceId?: string | null;
  classroomId?: string | null;
  classroomName?: string | null;
  campusId?: string | null;
  campusName?: string | null;
  scheduledClassId?: string | null;
  assigneeId?: string | null;
  openedAt: string;
  acknowledgedAt?: string | null;
  resolvedAt?: string | null;
  resolutionCode?: ResolutionCode | null;
  resolutionNote?: string | null;
  slaDueAt: string;
  slaBreached: boolean;
  comments?: IncidentComment[];
  timeline?: IncidentTimelineEntry[];
}

export interface IncidentStats {
  mttaMinutes: number | null;
  mttrMinutes: number | null;
  openBySeverity: Partial<Record<Severity, number>>;
  slaBreaches: number;
}

export interface IncidentFilters {
  status?: string | undefined;
  severity?: string | undefined;
  type?: string | undefined;
  campusId?: string | undefined;
  assignee?: string | undefined;
  sort?: 'severity' | 'age' | undefined;
}

export const listIncidents = (
  f: IncidentFilters,
): Promise<ApiResult<{ items: Incident[] } | Incident[]>> =>
  apiGet('notifications', `/v1/incidents${query({ institutionId: institutionId(), ...f })}`);

export const getIncident = (id: string): Promise<ApiResult<Incident>> =>
  apiGet('notifications', `/v1/incidents/${encodeURIComponent(id)}`);

export const getIncidentStats = (p: {
  from: string;
  to: string;
}): Promise<ApiResult<IncidentStats>> =>
  apiGet('notifications', `/v1/incidents/stats${query({ institutionId: institutionId(), ...p })}`);

const post = <T>(id: string, action: string, body: unknown): Promise<ApiResult<T>> =>
  apiRequest<T>('notifications', `/v1/incidents/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    body,
  });

export const assignIncident = (
  id: string,
  assigneeId: string,
  actorId: string,
): Promise<ApiResult<Incident>> => post(id, 'assign', { assigneeId, actorId });

export const setIncidentStatus = (
  id: string,
  status: 'acknowledged' | 'in_progress',
  actorId: string,
): Promise<ApiResult<Incident>> => post(id, 'status', { status, actorId });

export const commentIncident = (
  id: string,
  body: string,
  actorId: string,
): Promise<ApiResult<unknown>> => post(id, 'comments', { body, actorId });

/** Resolution goes through the status endpoint and requires a resolutionCode (contract §4). */
export const resolveIncident = (
  id: string,
  resolutionCode: ResolutionCode,
  note: string | undefined,
  actorId: string,
): Promise<ApiResult<Incident>> =>
  post(id, 'status', { status: 'resolved', resolutionCode, ...(note ? { note } : {}), actorId });
