import type { Device, DeviceStatus, HealthIssue, Heartbeat } from './domain.js';

export const HEALTH_THRESHOLDS = {
  offlineAfterSeconds: 180,
  lowDiskBytes: 1024 ** 3,
  highTemperatureC: 80,
  uploadBacklogCount: 20,
  certificateExpiringDays: 30,
  maxClockSkewMs: 5000,
} as const;

export interface DerivedHealth {
  status: DeviceStatus;
  issues: HealthIssue[];
}

/**
 * Status precedence: decommissioned > maintenance > offline > attention_required > recording > uploading > online.
 * Issues are always reported, even when a higher-precedence status is shown.
 */
export function deriveHealth(
  device: Device,
  latest: Heartbeat | undefined,
  now: Date,
): DerivedHealth {
  if (device.credentialStatus === 'decommissioned') return { status: 'decommissioned', issues: [] };

  const issues: HealthIssue[] = [];
  if (device.credentialStatus === 'revoked') issues.push('certificate_revoked');
  if (!device.classroomId) issues.push('unassigned');
  const expiresInMs = Date.parse(device.certificateExpiresAt) - now.getTime();
  if (expiresInMs < HEALTH_THRESHOLDS.certificateExpiringDays * 86_400_000)
    issues.push('certificate_expiring');

  let offline = false;
  if (!latest) {
    issues.push('no_heartbeat');
    offline = true;
  } else {
    const ageSeconds = (now.getTime() - Date.parse(latest.receivedAt)) / 1000;
    if (ageSeconds > HEALTH_THRESHOLDS.offlineAfterSeconds) {
      issues.push('heartbeat_missed');
      offline = true;
    }
    if (latest.diskFreeBytes < HEALTH_THRESHOLDS.lowDiskBytes) issues.push('low_disk');
    if (latest.cpuTempC !== undefined && latest.cpuTempC > HEALTH_THRESHOLDS.highTemperatureC)
      issues.push('high_temperature');
    if (Math.abs(latest.clockSkewMs ?? 0) > HEALTH_THRESHOLDS.maxClockSkewMs) issues.push('clock_skew');
    if ((latest.evictedRecordings ?? 0) > 0) issues.push('recordings_evicted');
    if (latest.bufferQueueCount > HEALTH_THRESHOLDS.uploadBacklogCount)
      issues.push('upload_backlog');
  }

  if (device.maintenanceMode) return { status: 'maintenance', issues };
  if (offline) return { status: 'offline', issues };
  const attention: HealthIssue[] = [
    'certificate_revoked',
    'low_disk',
    'high_temperature',
    'upload_backlog',
    'recordings_evicted',
  ];
  if (issues.some((i) => attention.includes(i))) return { status: 'attention_required', issues };
  if (latest?.isRecording) return { status: 'recording', issues };
  if ((latest?.bufferQueueCount ?? 0) > 0) return { status: 'uploading', issues };
  return { status: 'online', issues };
}
