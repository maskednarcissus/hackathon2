import type { Device, DeviceCommand, DeviceStatus, HealthIssue, Heartbeat } from './domain.js';
import { HEALTH_THRESHOLDS } from './health.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Numeric-aware version comparison ("1.10.0" > "1.9.3"); negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  const pb = b
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.localeCompare(b);
}

export interface UptimeReport {
  windowStart: string;
  windowEnd: string;
  windowHours: number;
  uptimePercent: number | null;
  expectedHeartbeats: number;
  receivedHeartbeats: number;
  missedHeartbeats: number;
  gaps: { from: string; to: string; durationSeconds: number }[];
}

/**
 * A device counts as "up" for `offlineAfterSeconds` after each heartbeat (the same rule that
 * derives the offline status). The window starts no earlier than the device registration.
 */
export function computeUptime(
  heartbeats: readonly Heartbeat[],
  device: Pick<Device, 'createdAt'>,
  now: Date,
  windowHours: number,
  heartbeatIntervalSeconds: number,
): UptimeReport {
  const end = now.getTime();
  const start = Math.max(end - windowHours * HOUR_MS, Date.parse(device.createdAt));
  const grace = HEALTH_THRESHOLDS.offlineAfterSeconds * 1000;
  const times = heartbeats
    .map((h) => Date.parse(h.receivedAt))
    .filter((t) => t >= start - grace && t <= end)
    .sort((a, b) => a - b);

  let up = 0;
  times.forEach((t, i) => {
    const next = times[i + 1] ?? end;
    const from = Math.max(t, start);
    const to = Math.min(t + grace, next, end);
    if (to > from) up += to - from;
  });

  const gaps: UptimeReport['gaps'] = [];
  const points = [start, ...times.filter((t) => t >= start), end];
  // The leading gap is measured from the last heartbeat before the window when there is one.
  const before = times.filter((t) => t < start).at(-1);
  if (before !== undefined) points[0] = before;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i] ?? start;
    const b = points[i + 1] ?? end;
    if (b - a > grace) {
      gaps.push({
        from: new Date(Math.max(a, start)).toISOString(),
        to: new Date(b).toISOString(),
        durationSeconds: Math.round((b - Math.max(a, start)) / 1000),
      });
    }
  }

  const windowMs = end - start;
  const received = times.filter((t) => t >= start).length;
  const expected = Math.floor(windowMs / (heartbeatIntervalSeconds * 1000));
  return {
    windowStart: new Date(start).toISOString(),
    windowEnd: now.toISOString(),
    windowHours,
    uptimePercent: windowMs > 0 ? Math.round((up / windowMs) * 1000) / 10 : null,
    expectedHeartbeats: expected,
    receivedHeartbeats: received,
    missedHeartbeats: Math.max(0, expected - received),
    gaps,
  };
}

export interface BacklogBucket {
  from: string;
  to: string;
  samples: number;
  maxBufferQueueCount: number | null;
  maxBufferQueueBytes: number | null;
  lastBufferQueueCount: number | null;
}

/** Hourly buckets ending at `now`, oldest first. */
export function backlogTrend(
  heartbeats: readonly Heartbeat[],
  now: Date,
  windowHours: number,
): BacklogBucket[] {
  const end = now.getTime();
  const buckets: BacklogBucket[] = [];
  for (let i = windowHours; i > 0; i -= 1) {
    const from = end - i * HOUR_MS;
    const to = from + HOUR_MS;
    const inBucket = heartbeats.filter((h) => {
      const t = Date.parse(h.receivedAt);
      return t >= from && t < to;
    });
    const last = inBucket.at(-1);
    buckets.push({
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      samples: inBucket.length,
      maxBufferQueueCount: last ? Math.max(...inBucket.map((h) => h.bufferQueueCount)) : null,
      maxBufferQueueBytes: last ? Math.max(...inBucket.map((h) => h.bufferQueueBytes)) : null,
      lastBufferQueueCount: last ? last.bufferQueueCount : null,
    });
  }
  return buckets;
}

export interface CertificateReport {
  issuedAt: string;
  expiresAt: string;
  daysRemaining: number;
  status: 'valid' | 'expiring' | 'expired' | 'revoked';
}

export function certificateReport(device: Device, now: Date): CertificateReport {
  const remainingMs = Date.parse(device.certificateExpiresAt) - now.getTime();
  let status: CertificateReport['status'] = 'valid';
  if (device.credentialStatus !== 'active') status = 'revoked';
  else if (remainingMs <= 0) status = 'expired';
  else if (remainingMs < HEALTH_THRESHOLDS.certificateExpiringDays * DAY_MS) status = 'expiring';
  return {
    issuedAt: device.certificateIssuedAt,
    expiresAt: device.certificateExpiresAt,
    daysRemaining: Math.floor(remainingMs / DAY_MS),
    status,
  };
}

/** Firmware versions reported in the window, in the order they first appeared. */
export function firmwareHistory(
  heartbeats: readonly Heartbeat[],
): { version: string; firstSeenAt: string; lastSeenAt: string }[] {
  const seen = new Map<string, { version: string; firstSeenAt: string; lastSeenAt: string }>();
  for (const h of heartbeats) {
    const entry = seen.get(h.firmwareVersion);
    if (entry) entry.lastSeenAt = h.receivedAt;
    else
      seen.set(h.firmwareVersion, {
        version: h.firmwareVersion,
        firstSeenAt: h.receivedAt,
        lastSeenAt: h.receivedAt,
      });
  }
  return [...seen.values()];
}

export interface FirmwareDistribution {
  generatedAt: string;
  total: number;
  latestVersion: string | null;
  outdated: number;
  versions: {
    version: string;
    count: number;
    percent: number;
    isLatest: boolean;
    deviceIds: string[];
  }[];
}

export function firmwareDistribution(devices: readonly Device[], now: Date): FirmwareDistribution {
  const active = devices.filter((d) => d.credentialStatus !== 'decommissioned');
  const groups = new Map<string, string[]>();
  for (const d of active)
    groups.set(d.firmwareVersion, [...(groups.get(d.firmwareVersion) ?? []), d.id]);
  const versions = [...groups.keys()].sort((a, b) => compareVersions(b, a));
  const latest = versions[0] ?? null;
  return {
    generatedAt: now.toISOString(),
    total: active.length,
    latestVersion: latest,
    outdated: active.filter((d) => d.firmwareVersion !== latest).length,
    versions: versions.map((version) => {
      const ids = groups.get(version) ?? [];
      return {
        version,
        count: ids.length,
        percent: Math.round((ids.length / Math.max(active.length, 1)) * 1000) / 10,
        isLatest: version === latest,
        deviceIds: ids,
      };
    }),
  };
}

export const commandView = (
  c: DeviceCommand,
): Omit<DeviceCommand, 'id'> & { commandId: string } => {
  const { id, ...rest } = c;
  return { commandId: id, ...rest };
};

export interface FleetRow {
  deviceId: string;
  serialNumber: string;
  model: string;
  firmwareVersion: string;
  institutionId: string;
  status: DeviceStatus;
  issues: HealthIssue[];
  lastSeenAt: string | null;
  classroom: { id: string; name: string | null; code: string | null } | null;
  campus: { id: string; name: string | null } | null;
  metrics: {
    diskFreeBytes: number;
    bufferQueueCount: number;
    cpuTempC: number | null;
    isRecording: boolean;
  } | null;
  openCommands: number;
}
