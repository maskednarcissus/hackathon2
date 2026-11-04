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
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PolicySource = 'classroom' | 'campus' | 'institution_default';
