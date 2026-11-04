import { redirect } from 'next/navigation';
import { services, type ServiceName } from './config';
import { getSession } from './session';

export type ApiResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; status: number; code: string; message: string };

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Attach the session's bearer token (default true). */
  auth?: boolean;
  /** Explicit token (used right after login, before cookies are readable). */
  token?: string;
  timeoutMs?: number;
}

function buildUrl(service: ServiceName, path: string, query?: RequestOptions['query']): string {
  const url = new URL(services[service] + path);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

/**
 * Server-side fetch against an upstream service. Never throws: network failures and non-2xx
 * responses are returned as `{ ok: false }` so pages can render explicit error states.
 */
export async function request<T>(
  service: ServiceName,
  path: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let token = options.token;
  if (token === undefined && options.auth !== false) {
    token = (await getSession())?.accessToken;
  }
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(service, path, options.query), {
      method: options.method ?? 'GET',
      headers,
      ...(body !== undefined ? { body } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      code: 'service_unavailable',
      message: 'Não foi possível conectar ao serviço. Tente novamente em instantes.',
    };
  }

  if (response.status === 204) return { ok: true, data: undefined as T, status: 204 };

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const err = (parsed as ErrorBody | undefined)?.error;
    return {
      ok: false,
      status: response.status,
      code: err?.code ?? `http_${response.status}`,
      message: err?.message ?? 'O serviço retornou um erro inesperado.',
    };
  }
  return { ok: true, data: parsed as T, status: response.status };
}

/** True when the upstream rejected the session token. */
export function isUnauthorized<T>(result: ApiResult<T>): boolean {
  return !result.ok && result.status === 401;
}

/** In pages: an expired/invalid session sends the student back to the login page. */
export function guard<T>(result: ApiResult<T>): ApiResult<T> {
  if (isUnauthorized(result)) redirect('/entrar?sessao=expirada');
  return result;
}
