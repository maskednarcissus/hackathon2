/** device-management fleet console client (Phase 4 contract §3). Server-side only. */
import type { ApiResult, FleetDevice } from './fleet';
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
}

export interface FleetPage {
  items: FleetConsoleDevice[];
  page: number;
  pageSize: number;
  total: number;
  /** Optional facet values for filter dropdowns. */
  facets?: { firmwareVersions?: string[]; campuses?: { id: string; name: string }[] };
}

export interface DeviceCommand {
  commandId: string;
  type: Open<CommandType>;
  status: Open<'pending' | 'delivered' | 'succeeded' | 'failed' | 'expired'>;
  requestedBy?: string;
  issuedAt: string;
  expiresAt?: string;
  finishedAt?: string | null;
  output?: unknown;
}

export interface Diagnostics {
  deviceId: string;
  latestHeartbeat?: Record<string, unknown> & { receivedAt?: string };
  uptimePercent24h: number | null;
  missedHeartbeats24h: number | null;
  uploadBacklogTrend?: { at: string; queuedRecordings: number }[];
  firmwareVersion?: string;
  certificateExpiresAt?: string | null;
  lastCommands?: DeviceCommand[];
}

export interface FirmwareDistribution {
  versions: { version: string; count: number }[];
}

export interface FleetFilters {
  campusId?: string | undefined;
  status?: string | undefined;
  firmwareVersion?: string | undefined;
  q?: string | undefined;
  sort?: string | undefined;
  page?: number | undefined;
}

export const getFleetPage = (f: FleetFilters): Promise<ApiResult<FleetPage>> =>
  apiGet('devices', `/v1/fleet${query({ institutionId: institutionId(), ...f })}`);

export const getFirmware = (): Promise<ApiResult<FirmwareDistribution>> =>
  apiGet('devices', `/v1/fleet/firmware${query({ institutionId: institutionId() })}`);

export const getDiagnostics = (deviceId: string): Promise<ApiResult<Diagnostics>> =>
  apiGet('devices', `/v1/devices/${encodeURIComponent(deviceId)}/diagnostics`);

export const sendCommand = (
  deviceId: string,
  type: CommandType,
  requestedBy: string,
): Promise<ApiResult<{ commandId: string; status: string }>> =>
  apiRequest('devices', `/v1/devices/${encodeURIComponent(deviceId)}/commands`, {
    method: 'POST',
    body: { type, requestedBy },
  });
