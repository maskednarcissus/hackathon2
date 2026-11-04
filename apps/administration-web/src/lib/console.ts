/** device-management fleet console client (Phase 4 contract §3). Server-side only. */
import { normalizeMetrics, type ApiResult, type FleetDevice, type WireMetrics } from './fleet';
import type { Open } from './open';
import { apiGet, apiRequest, institutionId, query } from './http';

export const COMMAND_TYPES = [
  'reboot',
  'self_test',
  'upload_now',
  'refresh_plan',
  'rotate_logs',
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export const COMMAND_LABELS: Record<CommandType, string> = {
  reboot: 'Reiniciar',
  self_test: 'Autoteste',
  upload_now: 'Enviar agora',
  refresh_plan: 'Atualizar agenda',
  rotate_logs: 'Rotacionar logs',
};

export const isCommandType = (v: string): v is CommandType =>
  (COMMAND_TYPES as readonly string[]).includes(v);

export interface FleetConsoleDevice extends FleetDevice {
  campusId?: string | null;
  campusName?: string | null;
  openCommands?: number;
}

export interface FleetPage {
  items: FleetConsoleDevice[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  summary: { total: number; byStatus: Partial<Record<string, number>> };
  /** organization was unreachable: classroom/campus names are missing. */
  namesUnavailable: boolean;
}

export const COMMAND_STATUSES = [
  'pending',
  'delivered',
  'succeeded',
  'failed',
  'expired',
  'cancelled',
] as const;

export interface DeviceCommand {
  commandId: string;
  type: Open<CommandType>;
  status: Open<(typeof COMMAND_STATUSES)[number]>;
  requestedBy?: string;
  issuedAt: string;
  expiresAt?: string;
  deliveredAt?: string;
  finishedAt?: string | null;
  output?: unknown;
}

export interface BacklogPoint {
  at: string;
  queuedRecordings: number | null;
}

export interface Diagnostics {
  deviceId: string;
  uptimePercent24h: number | null;
  missedHeartbeats24h: number | null;
  expectedHeartbeats24h: number | null;
  gaps: { from: string; to: string; durationSeconds: number }[];
  uploadBacklogTrend: BacklogPoint[];
  firmwareVersion: string | null;
  firmwareHistory: { version: string; firstSeenAt: string; lastSeenAt: string }[];
  certificateExpiresAt: string | null;
  certificateStatus: string | null;
  lastCommands: DeviceCommand[];
}

export interface FirmwareDistribution {
  total: number;
  latestVersion: string | null;
  outdated: number;
  versions: { version: string; count: number; percent: number; isLatest: boolean }[];
}

/** `sort` values accepted by device-management (`-` prefix = descending). */
export const FLEET_SORTS = ['serialNumber', 'status', 'lastSeenAt', 'firmwareVersion', 'classroom', 'campus'] as const;

export interface FleetFilters {
  campusId?: string | undefined;
  status?: string | undefined;
  firmwareVersion?: string | undefined;
  q?: string | undefined;
  sort?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

// ---- wire shapes (services/device-management/src/app.ts) -------------------------------------

interface WireFleetRow {
  deviceId: string;
  serialNumber: string;
  model: string;
  firmwareVersion: string;
  institutionId: string;
  status: string;
  issues: string[];
  lastSeenAt: string | null;
  classroom: { id: string; name: string | null; code: string | null } | null;
  campus: { id: string; name: string | null } | null;
  metrics: WireMetrics | null;
  openCommands: number;
}

interface WireFleetPage {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  summary: FleetPage['summary'];
  namesUnavailable: boolean;
  items: WireFleetRow[];
}

interface WireDiagnostics {
  deviceId: string;
  uptime: {
    uptimePercent: number | null;
    expectedHeartbeats: number;
    missedHeartbeats: number;
    gaps: { from: string; to: string; durationSeconds: number }[];
  };
  backlogTrend: { to: string; lastBufferQueueCount: number | null; maxBufferQueueCount: number | null }[];
  firmware: { current: string; history: { version: string; firstSeenAt: string; lastSeenAt: string }[] };
  certificate: { expiresAt: string; status: string } | null;
  lastCommands: DeviceCommand[];
}

const fleetRow = (r: WireFleetRow): FleetConsoleDevice => ({
  deviceId: r.deviceId,
  serialNumber: r.serialNumber,
  model: r.model,
  firmwareVersion: r.firmwareVersion,
  status: r.status,
  institutionId: r.institutionId,
  classroomId: r.classroom?.id ?? null,
  classroomName: r.classroom?.name ?? r.classroom?.code ?? null,
  campusId: r.campus?.id ?? null,
  campusName: r.campus?.name ?? null,
  lastSeenAt: r.lastSeenAt,
  metrics: normalizeMetrics(r.metrics),
  issues: r.issues,
  openCommands: r.openCommands,
});

export async function getFleetPage(f: FleetFilters): Promise<ApiResult<FleetPage>> {
  const res = await apiGet<WireFleetPage>(
    'devices',
    `/v1/fleet${query({ institutionId: institutionId(), ...f })}`,
  );
  if (!res.ok) return res;
  return { ...res, data: { ...res.data, items: res.data.items.map(fleetRow) } };
}

export const getFirmware = (): Promise<ApiResult<FirmwareDistribution>> =>
  apiGet('devices', `/v1/fleet/firmware${query({ institutionId: institutionId() })}`);

export async function getDiagnostics(deviceId: string): Promise<ApiResult<Diagnostics>> {
  const res = await apiGet<WireDiagnostics>(
    'devices',
    `/v1/devices/${encodeURIComponent(deviceId)}/diagnostics`,
  );
  if (!res.ok) return res;
  const d = res.data;
  return {
    ...res,
    data: {
      deviceId: d.deviceId,
      uptimePercent24h: d.uptime.uptimePercent,
      missedHeartbeats24h: d.uptime.missedHeartbeats,
      expectedHeartbeats24h: d.uptime.expectedHeartbeats,
      gaps: d.uptime.gaps,
      uploadBacklogTrend: d.backlogTrend.map((b) => ({
        at: b.to,
        queuedRecordings: b.lastBufferQueueCount ?? b.maxBufferQueueCount,
      })),
      firmwareVersion: d.firmware.current,
      firmwareHistory: d.firmware.history,
      certificateExpiresAt: d.certificate?.expiresAt ?? null,
      certificateStatus: d.certificate?.status ?? null,
      lastCommands: d.lastCommands,
    },
  };
}

export const sendCommand = (
  deviceId: string,
  type: CommandType,
  requestedBy: string,
): Promise<
  ApiResult<{ commandId: string; status: string; expiresAt?: string; deduplicated?: boolean }>
> =>
  apiRequest('devices', `/v1/devices/${encodeURIComponent(deviceId)}/commands`, {
    method: 'POST',
    body: { type, requestedBy },
  });

export const cancelCommand = (deviceId: string, commandId: string): Promise<ApiResult<unknown>> =>
  apiRequest(
    'devices',
    `/v1/devices/${encodeURIComponent(deviceId)}/commands/${encodeURIComponent(commandId)}/cancel`,
    { method: 'POST', body: {} },
  );
