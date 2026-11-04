/**
 * Server-side HTTP client for the Phase 4 backends. Import only from Server Components,
 * Server Actions and Route Handlers — it reads the admin API token from the environment.
 *
 * Authentication: until the administration login flow lands, every call carries a
 * coordinator/admin bearer token from ADMIN_API_TOKEN (identity §2). Actions are attributed
 * to ADMIN_USER_ID.
 */
import type { ApiResult } from './fleet';

export type Service = 'analytics' | 'devices' | 'notifications' | 'organization' | 'identity';

const DEFAULTS: Record<Service, { env: string; url: string; label: string }> = {
  analytics: {
    env: 'ACADEMIC_ANALYTICS_URL',
    url: 'http://localhost:4009',
    label: 'academic-analytics',
  },
  devices: {
    env: 'DEVICE_MANAGEMENT_URL',
    url: 'http://localhost:4004',
    label: 'device-management',
  },
  notifications: { env: 'NOTIFICATIONS_URL', url: 'http://localhost:4006', label: 'notifications' },
  organization: { env: 'ORGANIZATION_URL', url: 'http://localhost:4002', label: 'organization' },
  identity: { env: 'IDENTITY_URL', url: 'http://localhost:4001', label: 'identity' },
};

export const serviceLabel = (s: Service): string => DEFAULTS[s].label;

export function serviceUrl(service: Service): string {
  const d = DEFAULTS[service];
  return (process.env[d.env] ?? d.url).replace(/\/$/, '');
}

/** Institution in scope for this admin session (single-tenant until login lands). */
export const institutionId = (): string =>
  process.env.ADMIN_INSTITUTION_ID ?? '00000000-0000-4000-8000-0000000000aa';

export const actorId = (): string =>
  process.env.ADMIN_USER_ID ?? '00000000-0000-4000-8000-0000000000ad';

export function authHeaders(): Record<string, string> {
  const token = process.env.ADMIN_API_TOKEN ?? process.env.DEVICE_MANAGEMENT_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

export function query(
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

interface ErrorBody {
  error?: { code?: string; message?: string };
  message?: string;
}

async function errorMessage(res: Response, service: Service): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as ErrorBody;
    detail = body.error?.message ?? body.message ?? '';
  } catch {
    /* body not JSON */
  }
  return `O serviço ${serviceLabel(service)} respondeu HTTP ${res.status}${detail ? `: ${detail}` : '.'}`;
}

export async function apiRequest<T>(
  service: Service,
  path: string,
  init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<ApiResult<T>> {
  const fetchedAt = new Date().toISOString();
  try {
    const res = await fetch(`${serviceUrl(service)}${path}`, {
      method: init.method ?? 'GET',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...authHeaders(),
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: await errorMessage(res, service), fetchedAt };
    }
    const data = (res.status === 204 ? undefined : await res.json()) as T;
    return { ok: true, data, fetchedAt };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Não foi possível contatar o serviço ${serviceLabel(service)} (${reason}).`,
      fetchedAt,
    };
  }
}

export const apiGet = <T>(service: Service, path: string): Promise<ApiResult<T>> =>
  apiRequest<T>(service, path);

/** Lists are accepted either as a bare array or wrapped in `{ items }`. */
export function itemsOf<T>(data: T[] | { items?: T[] } | null | undefined): T[] {
  if (Array.isArray(data)) return data;
  return data?.items ?? [];
}

export const today = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const isIsoDate = (v: string | undefined): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
