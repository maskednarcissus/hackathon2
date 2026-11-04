/**
 * HTTP plumbing shared by all connectors: authentication, retries, rate limits and paging stats.
 *
 * * `429` → waits `Retry-After` (seconds or HTTP date; exponential backoff when absent), up to
 *   `maxRetries`; a wait longer than `maxRetryAfterMs` fails fast with `rate_limited`.
 * * `5xx` / network errors / timeouts → exponential backoff, then `upstream_unavailable`.
 * * `401` → the auth provider is invalidated once (token refresh), then the request is retried.
 * * Other `4xx` → `ConnectorError` (`http_<status>`), not retried.
 * * Absolute URLs (paging links) must stay on the configured origin: credentials are never sent elsewhere.
 */
import { createSign, randomUUID } from 'node:crypto';
import type { AuthKind } from './types.js';

export interface HttpDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const defaultHttpDeps = (): HttpDeps => ({
  fetch: globalThis.fetch,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
});

export class ConnectorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface AuthProvider {
  /** Headers (and query parameters, e.g. Moodle's `wstoken`) to add to a request. */
  apply(): Promise<{ headers?: Record<string, string>; query?: Record<string, string> }>;
  invalidate(): void;
}

export const noAuth: AuthProvider = { apply: () => Promise.resolve({}), invalidate: () => {} };

export class StaticHeaderAuth implements AuthProvider {
  constructor(private readonly headers: Record<string, string>) {}
  apply(): Promise<{ headers: Record<string, string> }> {
    return Promise.resolve({ headers: this.headers });
  }
  invalidate(): void {}
}

export class QueryTokenAuth implements AuthProvider {
  constructor(private readonly query: Record<string, string>) {}
  apply(): Promise<{ query: Record<string, string> }> {
    return Promise.resolve({ query: this.query });
  }
  invalidate(): void {}
}

export const basicHeader = (user: string, password: string): string =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

interface CachedToken {
  value: string;
  expiresAt: number;
}

/** Base for providers that obtain a bearer token and cache it until shortly before expiry. */
abstract class TokenAuth implements AuthProvider {
  private cached: CachedToken | null = null;
  private inflight: Promise<CachedToken> | null = null;
  constructor(protected readonly deps: HttpDeps) {}

  protected abstract fetchToken(): Promise<CachedToken>;

  async apply(): Promise<{ headers: Record<string, string> }> {
    if (!this.cached || this.cached.expiresAt - 30_000 <= this.deps.now()) {
      this.inflight ??= this.fetchToken().finally(() => {
        this.inflight = null;
      });
      this.cached = await this.inflight;
    }
    return { headers: { authorization: `Bearer ${this.cached.value}` } };
  }

  invalidate(): void {
    this.cached = null;
  }

  protected async tokenRequest(url: string, init: RequestInit): Promise<CachedToken> {
    let res: Response;
    try {
      res = await this.deps.fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new ConnectorError('auth_unavailable', `token endpoint unreachable: ${String(err)}`);
    }
    if (!res.ok) throw new ConnectorError('auth_failed', `token endpoint returned ${res.status}`, res.status);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string')
      throw new ConnectorError('auth_failed', 'token response has no access_token');
    const ttl = typeof body.expires_in === 'number' ? body.expires_in * 1000 : 3_600_000;
    return { value: body.access_token, expiresAt: this.deps.now() + ttl };
  }
}

/** OAuth 2.0 client credentials (RFC 6749 §4.4), client authenticated with HTTP Basic. */
export class OAuth2ClientCredentials extends TokenAuth {
  constructor(
    deps: HttpDeps,
    private readonly tokenUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly scope?: string,
  ) {
    super(deps);
  }
  protected fetchToken(): Promise<CachedToken> {
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (this.scope) form.set('scope', this.scope);
    return this.tokenRequest(this.tokenUrl, {
      method: 'POST',
      headers: {
        authorization: basicHeader(this.clientId, this.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
    });
  }
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/**
 * LTI 1.3 / LTI Advantage service access: client credentials grant with a signed JWT client
 * assertion (RFC 7523, RS256), as used for Names & Role Provisioning and other LTI services.
 */
export class Lti13ClientAssertion extends TokenAuth {
  constructor(
    deps: HttpDeps,
    private readonly tokenUrl: string,
    private readonly clientId: string,
    private readonly privateKeyPem: string,
    private readonly keyId: string | undefined,
    private readonly scope: string | undefined,
  ) {
    super(deps);
  }
  /** Exposed for tests. */
  assertion(): string {
    const now = Math.floor(this.deps.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', ...(this.keyId ? { kid: this.keyId } : {}) };
    const claims = {
      iss: this.clientId,
      sub: this.clientId,
      aud: this.tokenUrl,
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
    };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    const signature = createSign('RSA-SHA256').update(input).sign(this.privateKeyPem);
    return `${input}.${b64url(signature)}`;
  }
  protected fetchToken(): Promise<CachedToken> {
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: this.assertion(),
    });
    if (this.scope) form.set('scope', this.scope);
    return this.tokenRequest(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    });
  }
}

/** Ellucian Ethos Integration: `POST {base}/auth` with the API key → JWT (valid 5 minutes). */
export class EthosAuth extends TokenAuth {
  constructor(
    deps: HttpDeps,
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {
    super(deps);
  }
  protected async fetchToken(): Promise<CachedToken> {
    let res: Response;
    try {
      res = await this.deps.fetch(`${this.baseUrl}/auth`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, accept: 'text/plain' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ConnectorError('auth_unavailable', `Ethos auth unreachable: ${String(err)}`);
    }
    if (!res.ok) throw new ConnectorError('auth_failed', `Ethos auth returned ${res.status}`, res.status);
    return { value: (await res.text()).trim(), expiresAt: this.deps.now() + 4 * 60_000 };
  }
}

export interface Credential {
  kind: AuthKind;
  /** api_key */
  apiKey?: string;
  /** basic */
  username?: string;
  password?: string;
  /** oauth2_client_credentials / lti13 */
  clientId?: string;
  clientSecret?: string;
  privateKeyPem?: string;
  keyId?: string;
}

/**
 * Secret formats: `api_key` → the key; `basic` → `user:password` or `{"username","password"}`;
 * `oauth2_client_credentials` → `{"clientId","clientSecret"}`; `lti13` → `{"clientId","privateKeyPem","keyId?"}`.
 */
export function parseCredential(kind: AuthKind, raw: string): Credential {
  const json = (): Record<string, unknown> => {
    try {
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* fall through */
    }
    throw new ConnectorError('invalid_secret', `secret for ${kind} must be a JSON object`);
  };
  const str = (o: Record<string, unknown>, k: string): string => {
    const v = o[k];
    if (typeof v !== 'string' || v.length === 0)
      throw new ConnectorError('invalid_secret', `secret is missing "${k}"`);
    return v;
  };
  switch (kind) {
    case 'api_key':
      if (!raw.trim()) throw new ConnectorError('invalid_secret', 'empty API key');
      return { kind, apiKey: raw.trim() };
    case 'basic': {
      if (raw.trim().startsWith('{')) {
        const o = json();
        return { kind, username: str(o, 'username'), password: str(o, 'password') };
      }
      const i = raw.indexOf(':');
      if (i <= 0) throw new ConnectorError('invalid_secret', 'basic secret must be user:password');
      return { kind, username: raw.slice(0, i), password: raw.slice(i + 1) };
    }
    case 'oauth2_client_credentials': {
      const o = json();
      return { kind, clientId: str(o, 'clientId'), clientSecret: str(o, 'clientSecret') };
    }
    case 'lti13': {
      const o = json();
      const keyId = typeof o['keyId'] === 'string' ? o['keyId'] : undefined;
      return {
        kind,
        clientId: str(o, 'clientId'),
        privateKeyPem: str(o, 'privateKeyPem'),
        ...(keyId ? { keyId } : {}),
      };
    }
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | readonly string[] | undefined>;
  headers?: Record<string, string>;
  /** JSON body */
  json?: unknown;
  /** application/x-www-form-urlencoded body */
  form?: Record<string, string>;
  /** Treat this status as an empty result instead of an error (e.g. 404 for optional lookups). */
  allowStatus?: number[];
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

export interface HttpStats {
  requests: number;
  retries: number;
  rateLimited: number;
  pages: number;
}

export class ConnectorHttp {
  readonly stats: HttpStats = { requests: 0, retries: 0, rateLimited: 0, pages: 0 };
  private readonly origin: string;

  constructor(
    readonly baseUrl: string,
    private readonly auth: AuthProvider,
    private readonly deps: HttpDeps,
    private readonly options: { maxRetries?: number; maxRetryAfterMs?: number; timeoutMs?: number } = {},
  ) {
    this.origin = new URL(baseUrl).origin;
  }

  url(pathOrUrl: string, query?: RequestOptions['query'], extra?: Record<string, string>): URL {
    const url = /^https?:\/\//.test(pathOrUrl)
      ? new URL(pathOrUrl)
      : new URL(`${this.baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`);
    if (url.origin !== this.origin)
      throw new ConnectorError('foreign_origin', `refusing to follow ${url.origin} (configured ${this.origin})`);
    for (const [k, v] of Object.entries({ ...(query ?? {}), ...(extra ?? {}) })) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v as readonly string[]) url.searchParams.append(k, item);
      else url.searchParams.set(k, String(v));
    }
    return url;
  }

  private retryAfterMs(res: Response, attempt: number): number {
    const header = res.headers.get('retry-after');
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
      const at = Date.parse(header);
      if (!Number.isNaN(at)) return Math.max(0, at - this.deps.now());
    }
    return 1000 * 2 ** attempt;
  }

  async request(method: string, pathOrUrl: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    const maxRetries = this.options.maxRetries ?? 4;
    const maxWait = this.options.maxRetryAfterMs ?? 60_000;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const auth = await this.auth.apply();
      const url = this.url(pathOrUrl, opts.query, auth.query);
      const headers: Record<string, string> = {
        accept: 'application/json',
        ...(auth.headers ?? {}),
        ...(opts.headers ?? {}),
      };
      let body: string | undefined;
      if (opts.json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(opts.json);
      } else if (opts.form) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(opts.form).toString();
      }
      this.stats.requests++;
      let res: Response;
      try {
        res = await this.deps.fetch(url.toString(), {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
        });
      } catch (err) {
        if (attempt >= maxRetries)
          throw new ConnectorError('upstream_unavailable', `${method} ${url.pathname}: ${String(err)}`);
        this.stats.retries++;
        await this.deps.sleep(500 * 2 ** attempt);
        continue;
      }
      if (res.status === 429) {
        this.stats.rateLimited++;
        const wait = this.retryAfterMs(res, attempt);
        if (attempt >= maxRetries || wait > maxWait)
          throw new ConnectorError('rate_limited', `${url.pathname} rate limited (retry after ${Math.round(wait / 1000)} s)`, 429);
        this.stats.retries++;
        await this.deps.sleep(wait);
        continue;
      }
      if (res.status >= 500) {
        if (attempt >= maxRetries)
          throw new ConnectorError('upstream_unavailable', `${method} ${url.pathname} returned ${res.status}`, res.status);
        this.stats.retries++;
        await this.deps.sleep(500 * 2 ** attempt);
        continue;
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.auth.invalidate();
        continue;
      }
      if (!res.ok && !(opts.allowStatus ?? []).includes(res.status))
        throw new ConnectorError(`http_${res.status}`, `${method} ${url.pathname} returned ${res.status}`, res.status);
      const text = await res.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      return { status: res.status, headers: res.headers, body: parsed };
    }
  }

  get(pathOrUrl: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    return this.request('GET', pathOrUrl, opts);
  }

  post(pathOrUrl: string, opts: RequestOptions = {}): Promise<HttpResponse> {
    return this.request('POST', pathOrUrl, opts);
  }
}

/** Parses an RFC 8288 `Link` header and returns the `rel="next"` target. */
export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part.trim());
    if (m?.[1]) return m[1];
  }
  return null;
}

// ---- small JSON accessors (external payloads are untyped) ----
export type Json = Record<string, unknown>;
export const obj = (v: unknown): Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : undefined;
export const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
export const isEmail = (v: string | undefined): v is string =>
  v !== undefined && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
