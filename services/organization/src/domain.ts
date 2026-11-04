export interface HoldingCompany {
  id: string;
  name: string;
  legalName: string;
  country: string;
  createdAt: string;
  updatedAt: string;
}

export interface Institution {
  id: string;
  holdingCompanyId: string;
  name: string;
  brand?: string;
  country: string;
  state: string;
  createdAt: string;
  updatedAt: string;
}

export interface Campus {
  id: string;
  institutionId: string;
  name: string;
  city: string;
  state: string;
  timezone: string;
  /** Optional campus-level override of the institution default recording policy. */
  recordingPolicyId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Classroom {
  id: string;
  campusId: string;
  name: string;
  code: string;
  capacity?: number;
  /** Optional classroom-level override of the campus/institution recording policy. */
  recordingPolicyId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecordingPolicy {
  id: string;
  institutionId: string;
  name: string;
  description?: string;
  legalBasis: string;
  requiresExplicitConsent: boolean;
  audioRetentionDays: number;
  transcriptRetentionDays: number;
  summaryRetentionDays: number;
  allowRawAudioAccess: boolean;
  preRollMinutes: number;
  postRollMinutes: number;
  recordingEnabled: boolean;
  extractedEventRetentionDays: number;
  isDefault: boolean;
  /** Version number currently in force (1-based, incremented by every content change). */
  currentVersion: number;
  currentVersionId: string;
  createdAt: string;
  updatedAt: string;
}

/** Fields that define what a policy means; any change to them creates a new immutable version. */
export const POLICY_CONTENT_FIELDS = [
  'name',
  'description',
  'legalBasis',
  'requiresExplicitConsent',
  'audioRetentionDays',
  'transcriptRetentionDays',
  'summaryRetentionDays',
  'extractedEventRetentionDays',
  'allowRawAudioAccess',
  'preRollMinutes',
  'postRollMinutes',
  'recordingEnabled',
] as const;

export type PolicyContentField = (typeof POLICY_CONTENT_FIELDS)[number];
export type PolicyContent = Pick<RecordingPolicy, PolicyContentField>;

export interface RecordingPolicyVersion {
  id: string;
  policyId: string;
  institutionId: string;
  version: number;
  content: PolicyContent;
  changedFields: PolicyContentField[];
  changeReason?: string;
  createdBy: string | null;
  createdAt: string;
}

export type ConsentSubjectType = 'student' | 'professor';

export interface Consent {
  id: string;
  institutionId: string;
  subjectType: ConsentSubjectType;
  subjectId: string;
  policyId: string;
  /** Policy version the subject was shown when consenting. */
  policyVersion: number;
  /** Absent = applies to every class section under the policy. */
  classSectionId?: string;
  given: boolean;
  actorId: string;
  recordedAt: string;
  withdrawnAt?: string;
  withdrawnBy?: string;
  withdrawalReason?: string;
  supersededAt?: string;
  supersededBy?: string;
}

export type LegalHoldScopeType = 'class_section' | 'recording' | 'subject';

export interface LegalHold {
  id: string;
  institutionId: string;
  scope: { type: LegalHoldScopeType; id: string };
  reason: string;
  createdBy: string;
  createdAt: string;
  releasedAt?: string;
  releasedBy?: string;
  releaseReason?: string;
}

export const RETENTION_KINDS = ['audio', 'transcript', 'summary', 'extracted_event'] as const;
export type RetentionKind = (typeof RETENTION_KINDS)[number];

export interface RetentionKindResult {
  /** Items older than the shortest retention window, as reported by the data owner. */
  candidates: number;
  /** Candidates past their own policy's retention window. */
  due: number;
  deleted: number;
  /** Due items that would be deleted (dry run only). */
  wouldDelete: number;
  skippedHold: number;
  failed: number;
}

export interface RetentionJob {
  id: string;
  institutionId: string;
  dryRun: boolean;
  referenceTime: string;
  requestedBy: string | null;
  status: 'running' | 'completed' | 'completed_with_errors' | 'failed';
  startedAt: string;
  finishedAt?: string;
  kinds: Record<RetentionKind, RetentionKindResult>;
  holdsApplied: string[];
  /** Kinds with no data owner configured (nothing was evaluated for them). */
  unconfiguredKinds: RetentionKind[];
  errors: { kind: RetentionKind; target: string; message: string }[];
}

export type PolicySource = 'classroom' | 'campus' | 'institution_default';
