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

export const deviceManagementUrl = (): string =>
  (process.env.DEVICE_MANAGEMENT_URL ?? 'http://localhost:4004').replace(/\/$/, '');

async function getJson<T>(path: string): Promise<ApiResult<T>> {
  const fetchedAt = new Date().toISOString();
  const url = `${deviceManagementUrl()}${path}`;
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (process.env.DEVICE_MANAGEMENT_TOKEN) {
      headers.authorization = `Bearer ${process.env.DEVICE_MANAGEMENT_TOKEN}`;
    }
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

export const getFleetHealth = (): Promise<ApiResult<FleetHealth>> => getJson('/v1/fleet/health');

export const getDeviceHealth = (deviceId: string): Promise<ApiResult<DeviceHealth>> =>
  getJson(`/v1/devices/${encodeURIComponent(deviceId)}/health`);
