export interface RecordingPolicy {
  id: string;
  institutionId: string;
  name: string;
  legalBasis: string;
  requiresExplicitConsent: boolean;
  audioRetentionDays: number;
  transcriptRetentionDays: number;
  summaryRetentionDays: number;
  allowRawAudioAccess: boolean;
  createdAt: Date;
}

export interface AuditEvent {
  id: string;
  tenantId: string;
  actorId: string;
  actorType: 'student' | 'professor' | 'coordinator' | 'admin' | 'system';
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
  ipAddress?: string;
}
