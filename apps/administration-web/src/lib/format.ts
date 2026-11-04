/** pt-BR presentation helpers for the device dashboard (pure; safe on server and client). */

export interface StatusMeta {
  label: string;
  /** Text glyph so status is never conveyed by color alone. */
  icon: string;
  tone: 'success' | 'info' | 'warning' | 'danger' | 'muted';
  /** Sort order: most urgent first. */
  rank: number;
}

const STATUS: Record<string, StatusMeta> = {
  offline: { label: 'Offline', icon: '✕', tone: 'danger', rank: 0 },
  attention_required: { label: 'Requer atenção', icon: '!', tone: 'warning', rank: 1 },
  recording: { label: 'Gravando', icon: '●', tone: 'info', rank: 2 },
  uploading: { label: 'Enviando', icon: '↑', tone: 'info', rank: 3 },
  online: { label: 'Online', icon: '✓', tone: 'success', rank: 4 },
  maintenance: { label: 'Manutenção', icon: '⚙', tone: 'muted', rank: 5 },
  decommissioned: { label: 'Desativado', icon: '–', tone: 'muted', rank: 6 },
};

export const statusMeta = (status: string): StatusMeta =>
  STATUS[status] ?? { label: status, icon: '?', tone: 'muted', rank: 9 };

const ISSUES: Record<string, string> = {
  offline: 'Sem heartbeat recente',
  heartbeat_missed: 'Sem heartbeat recente',
  low_storage: 'Armazenamento baixo',
  low_disk: 'Armazenamento baixo',
  high_temperature: 'Temperatura alta',
  upload_backlog: 'Fila de envio acumulada',
  clock_skew: 'Relógio dessincronizado',
  recordings_evicted: 'Gravações descartadas por falta de espaço',
  unassigned: 'Sem sala atribuída',
  certificate_expiring: 'Certificado expirando',
  firmware_outdated: 'Firmware desatualizado',
};

export const issueLabel = (issue: string): string => ISSUES[issue] ?? issue.replace(/_/g, ' ');

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: unit >= 3 ? 1 : 0 })} ${units[unit]}`;
}

export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'nunca';
  const diffS = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(diffS)) return '—';
  if (diffS < 0) return 'agora';
  if (diffS < 60) return `há ${diffS} s`;
  if (diffS < 3600) return `há ${Math.floor(diffS / 60)} min`;
  if (diffS < 86_400) return `há ${Math.floor(diffS / 3600)} h`;
  return `há ${Math.floor(diffS / 86_400)} d`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

export function formatTemperature(c: number | null | undefined): string {
  return c == null ? '—' : `${c.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} °C`;
}

export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export function diskUsage(
  free: number | null | undefined,
  total: number | null | undefined,
): string {
  if (free == null) return '—';
  if (!total) return `${formatBytes(free)} livres`;
  const pct = Math.round((free / total) * 100);
  return `${formatBytes(free)} livres (${pct}%)`;
}
