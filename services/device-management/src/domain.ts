export type DeviceStatus =
  | 'online'
  | 'offline'
  | 'recording'
  | 'uploading'
  | 'attention_required'
  | 'maintenance'
  | 'decommissioned';

export const DEVICE_STATUSES: readonly DeviceStatus[] = [
  'online',
  'offline',
  'recording',
  'uploading',
  'attention_required',
  'maintenance',
  'decommissioned',
];

export type CredentialStatus = 'active' | 'revoked' | 'decommissioned';

export interface Device {
  id: string;
  serialNumber: string;
  model: string;
  firmwareVersion: string;
  institutionId: string;
  classroomId?: string;
  publicKeyPem: string;
  publicKeyFingerprint: string;
  certificate: string;
  certificateIssuedAt: string;
  certificateExpiresAt: string;
  credentialStatus: CredentialStatus;
  revokedAt?: string;
  revocationReason?: string;
  /** Operator-set maintenance mode suppresses health issues. */
  maintenanceMode: boolean;
  /** Last derived operational status, persisted to detect transitions. */
  status: DeviceStatus;
  lastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProvisioningToken {
  id: string;
  tokenHash: string;
  serialNumber: string;
  institutionId: string;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  usedAt?: string;
  deviceId?: string;
}

export interface DeviceAssignment {
  id: string;
  deviceId: string;
  classroomId: string;
  institutionId: string;
  assignedAt: string;
  assignedBy: string;
  unassignedAt?: string;
  unassignedBy?: string;
}

export interface HeartbeatMetrics {
  firmwareVersion: string;
  uptimeSeconds: number;
  cpuTempC: number;
  diskFreeBytes: number;
  diskTotalBytes: number;
  bufferQueueCount: number;
  bufferQueueBytes: number;
  networkRssiDbm?: number;
  micLevelDbfs?: number;
  isRecording: boolean;
  currentScheduledClassId?: string;
  lastUploadAt?: string;
}

export interface Heartbeat extends HeartbeatMetrics {
  id: string;
  deviceId: string;
  receivedAt: string;
  deviceTimestamp: string;
}

export type HealthIssue =
  | 'no_heartbeat'
  | 'heartbeat_missed'
  | 'low_disk'
  | 'high_temperature'
  | 'upload_backlog'
  | 'unassigned'
  | 'certificate_expiring'
  | 'certificate_revoked';
