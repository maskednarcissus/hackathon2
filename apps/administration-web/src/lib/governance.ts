/** organization (governance, retention) + identity (DSR) clients (Phase 4 contract §5, §6). */
import type { ApiResult } from './fleet';
import type { Open } from './open';
import { apiGet, apiRequest, institutionId, query } from './http';

export interface RecordingPolicy {
  id: string;
  institutionId: string;
  name: string;
  description?: string | null;
  legalBasis: string;
  requiresExplicitConsent: boolean;
  audioRetentionDays: number;
  transcriptRetentionDays: number;
  summaryRetentionDays: number;
  extractedEventRetentionDays?: number;
  allowRawAudioAccess: boolean;
  recordingEnabled?: boolean;
  version?: number;
  updatedAt?: string;
}

export interface PolicyVersion {
  version: number;
  createdAt: string;
  createdBy?: string | null;
  changes?: Record<string, { from: unknown; to: unknown }> | null;
  snapshot?: Partial<RecordingPolicy>;
}

export interface ConsentStatus {
  requiresExplicitConsent: boolean;
  allProfessorsConsented: boolean;
  studentsConsented: number | { suppressed: true } | null;
  studentsTotal: number | { suppressed: true } | null;
  recordingAllowed: boolean;
}

export interface LegalHold {
  id: string;
  scope: { type: 'class_section' | 'recording' | 'subject'; id: string };
  reason: string;
  createdBy?: string;
  createdAt: string;
  releasedAt?: string | null;
}

export const RETENTION_KINDS = ['audio', 'transcript', 'summary', 'extracted_event'] as const;

export interface RetentionKindCounts {
  candidates: number;
  deleted: number;
  skippedByHold: number;
  failures: number;
}

export interface RetentionJob {
  id: string;
  institutionId: string;
  dryRun: boolean;
  status: Open<'running' | 'completed' | 'failed'>;
  startedAt: string;
  finishedAt?: string | null;
  counts: Partial<Record<(typeof RETENTION_KINDS)[number], RetentionKindCounts>>;
}

export const DSR_TYPES = [
  'access',
  'correction',
  'deletion',
  'anonymization',
  'restriction',
] as const;
export const DSR_STATUSES = [
  'received',
  'verifying',
  'in_progress',
  'completed',
  'rejected',
] as const;

export interface DsrServiceResult {
  service: string;
  status: string;
  items: number;
  exportUri?: string | null;
}

export interface DataSubjectRequest {
  id: string;
  subjectType: Open<'student' | 'professor'>;
  subjectId: string;
  institutionId: string;
  type: Open<(typeof DSR_TYPES)[number]>;
  status: Open<(typeof DSR_STATUSES)[number]>;
  channel?: string;
  requestedBy?: string;
  details?: string | null;
  createdAt: string;
  dueAt: string;
  rejectionReason?: string | null;
  results?: DsrServiceResult[];
  timeline?: { at: string; status: string; actorId?: string | null; note?: string | null }[];
}

const inst = (): string => institutionId();

export const listPolicies = (): Promise<
  ApiResult<RecordingPolicy[] | { items: RecordingPolicy[] }>
> => apiGet('organization', `/v1/institutions/${encodeURIComponent(inst())}/recording-policies`);

export const listPolicyVersions = (
  id: string,
): Promise<ApiResult<PolicyVersion[] | { items: PolicyVersion[] }>> =>
  apiGet('organization', `/v1/recording-policies/${encodeURIComponent(id)}/versions`);

export const getConsentStatus = (classSectionId: string): Promise<ApiResult<ConsentStatus>> =>
  apiGet('organization', `/v1/class-sections/${encodeURIComponent(classSectionId)}/consent-status`);

export const listLegalHolds = (): Promise<ApiResult<LegalHold[] | { items: LegalHold[] }>> =>
  apiGet('organization', `/v1/legal-holds${query({ institutionId: inst(), active: true })}`);

export const createLegalHold = (
  scope: LegalHold['scope'],
  reason: string,
  actorId: string,
): Promise<ApiResult<LegalHold>> =>
  apiRequest('organization', '/v1/legal-holds', {
    method: 'POST',
    body: { institutionId: inst(), scope, reason, actorId },
  });

export const releaseLegalHold = (id: string): Promise<ApiResult<unknown>> =>
  apiRequest('organization', `/v1/legal-holds/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const listRetentionJobs = (): Promise<
  ApiResult<RetentionJob[] | { items: RetentionJob[] }>
> => apiGet('organization', `/v1/retention/jobs${query({ institutionId: inst() })}`);

export const runRetention = (dryRun: boolean): Promise<ApiResult<RetentionJob>> =>
  apiRequest('organization', '/v1/retention/run', {
    method: 'POST',
    body: { institutionId: inst(), now: new Date().toISOString(), dryRun },
  });

export const listDsr = (
  status?: string,
): Promise<ApiResult<DataSubjectRequest[] | { items: DataSubjectRequest[] }>> =>
  apiGet('identity', `/v1/dsr${query({ institutionId: inst(), status })}`);

export const getDsr = (id: string): Promise<ApiResult<DataSubjectRequest>> =>
  apiGet('identity', `/v1/dsr/${encodeURIComponent(id)}`);

export const dsrAction = (
  id: string,
  action: 'verify' | 'execute' | 'reject',
  body: Record<string, unknown>,
): Promise<ApiResult<DataSubjectRequest>> =>
  apiRequest('identity', `/v1/dsr/${encodeURIComponent(id)}/${action}`, { method: 'POST', body });
