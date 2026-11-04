/** Device-management fleet health API client (server-side only). */

export const DEVICE_STATUSES = [
  'online',
  'recording',
  'uploading',
  'attention_required',
  'offline',
  'maintenance',
  'decommissioned',
] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/** Heartbeat metrics (docs: hardware/device-protocol §3). All optional: older firmware may omit. */
export interface HeartbeatMetrics {
  firmwareVersion?: string;
  uptimeSeconds?: number | null;
  diskFreeBytes?: number | null;
  diskTotalBytes?: number | null;
  cpuTemperatureC?: number | null;
  queuedRecordings?: number | null;
  queuedBytes?: number | null;
  evictedRecordings?: number | null;
  isRecording?: boolean | null;
  currentScheduledClassId?: string | null;
  clockSkewMs?: number | null;
  lastError?: string | null;
  [key: string]: unknown;
}

export interface FleetDevice {
  deviceId: string;
  serialNumber: string;
  model: string;
  firmwareVersion: string;
  /** One of `DEVICE_STATUSES`; unknown values are rendered verbatim. */
  status: string;
  classroomId: string | null;
  classroomName?: string | null;
  institutionId: string | null;
  lastSeenAt: string | null;
  metrics: HeartbeatMetrics | null;
  issues: string[];
}

export interface FleetHealth {
  summary: { total: number; byStatus: Partial<Record<string, number>> };
  devices: FleetDevice[];
}

export interface HeartbeatSample extends HeartbeatMetrics {
  receivedAt: string;
}

export interface DeviceHealth {
  device: FleetDevice;
  heartbeats: HeartbeatSample[];
}

export type ApiResult<T> =
  | { ok: true; data: T; fetchedAt: string }
  | { ok: false; error: string; status?: number; fetchedAt: string };

/**
 * Wire shape of device-management heartbeat metrics (`HeartbeatMetrics` in
 * services/device-management/src/domain.ts).
 */
export interface WireMetrics {
  firmwareVersion?: string;
  uptimeSeconds?: number;
  cpuTempC?: number;
  diskFreeBytes?: number;
  diskTotalBytes?: number;
  bufferQueueCount?: number;
  bufferQueueBytes?: number;
  isRecording?: boolean;
  currentScheduledClassId?: string;
  evictedRecordings?: number;
  clockSkewMs?: number;
  lastError?: string;
  [key: string]: unknown;
}

/** Maps device-management metric names to the dashboard's names. */
export function normalizeMetrics(m: WireMetrics | null | undefined): HeartbeatMetrics | null {
  if (!m) return null;
  const { cpuTempC, bufferQueueCount, bufferQueueBytes, ...rest } = m;
  return {
    ...rest,
    cpuTemperatureC: cpuTempC ?? null,
    queuedRecordings: bufferQueueCount ?? null,
    queuedBytes: bufferQueueBytes ?? null,
  };
}

interface WireHealthRow extends Omit<FleetDevice, 'metrics'> {
  metrics: WireMetrics | null;
}

const normalizeRow = (row: WireHealthRow): FleetDevice => ({
  ...row,
  metrics: normalizeMetrics(row.metrics),
});

export const deviceManagementUrl = (): string =>
  (process.env.DEVICE_MANAGEMENT_URL ?? 'http://localhost:4004').replace(/\/$/, '');

export const institutionScope = (): string =>
  process.env.ADMIN_INSTITUTION_ID ?? '00000000-0000-4000-8000-0000000000aa';

async function getJson<T>(path: string): Promise<ApiResult<T>> {
  const fetchedAt = new Date().toISOString();
  const url = `${deviceManagementUrl()}${path}`;
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = process.env.ADMIN_API_TOKEN ?? process.env.DEVICE_MANAGEMENT_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(url, { cache: 'no-store', headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `O serviço respondeu HTTP ${res.status}.`,
        fetchedAt,
      };
    }
    return { ok: true, data: (await res.json()) as T, fetchedAt };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Não foi possível contatar o serviço de dispositivos (${reason}).`,
      fetchedAt,
    };
  }
}

export async function getFleetHealth(): Promise<ApiResult<FleetHealth>> {
  const res = await getJson<{ summary: FleetHealth['summary']; devices: WireHealthRow[] }>(
    `/v1/fleet/health?institutionId=${encodeURIComponent(institutionScope())}`,
  );
  if (!res.ok) return res;
  return { ...res, data: { summary: res.data.summary, devices: res.data.devices.map(normalizeRow) } };
}

/** device-management returns the health row flattened, with `heartbeats` alongside. */
export async function getDeviceHealth(deviceId: string): Promise<ApiResult<DeviceHealth>> {
  const res = await getJson<WireHealthRow & { heartbeats: (WireMetrics & { receivedAt: string })[] }>(
    `/v1/devices/${encodeURIComponent(deviceId)}/health`,
  );
  if (!res.ok) return res;
  const { heartbeats, ...row } = res.data;
  return {
    ...res,
    data: {
      device: normalizeRow(row),
      heartbeats: heartbeats.map((h) => ({ ...normalizeMetrics(h), receivedAt: h.receivedAt })),
    },
  };
}
