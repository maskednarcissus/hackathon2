/**
 * Recorded-response HTTP fake for connector tests (no live calls). A fixture file lists routes:
 * `{ method, path, query?, responses: [{ status?, headers?, body }] }`. A request matches a route when
 * method and path are equal and every listed query parameter has the given value; responses are
 * served in order and the last one repeats. Unmatched requests fail the test with a 599.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface FixtureResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface FixtureRoute {
  method?: string;
  path: string;
  query?: Record<string, string>;
  responses: FixtureResponse[];
}

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | null;
}

export function loadFixture(name: string): FixtureRoute[] {
  const file = fileURLToPath(new URL(`../connectors/fixtures/${name}.json`, import.meta.url));
  return (JSON.parse(readFileSync(file, 'utf8')) as { routes: FixtureRoute[] }).routes;
}

export class FixtureFetch {
  readonly calls: RecordedCall[] = [];
  readonly unmatched: string[] = [];
  private readonly served = new Map<FixtureRoute, number>();

  constructor(private readonly routes: FixtureRoute[]) {}

  /** Adds routes that take precedence over the fixture file. */
  prepend(...routes: FixtureRoute[]): this {
    this.routes.unshift(...routes);
    return this;
  }

  readonly fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    this.calls.push({ method, url, headers, body: typeof init?.body === 'string' ? init.body : null });
    const route = this.routes.find(
      (r) =>
        (r.method ?? 'GET').toUpperCase() === method &&
        r.path === url.pathname &&
        Object.entries(r.query ?? {}).every(([k, v]) => url.searchParams.get(k) === v),
    );
    if (!route) {
      this.unmatched.push(`${method} ${url.pathname}${url.search}`);
      return Promise.resolve(new Response(JSON.stringify({ error: 'no fixture' }), { status: 599 }));
    }
    const i = this.served.get(route) ?? 0;
    this.served.set(route, i + 1);
    const r = route.responses[Math.min(i, route.responses.length - 1)] ?? {};
    const body = typeof r.body === 'string' ? r.body : r.body === undefined ? '' : JSON.stringify(r.body);
    const status = r.status ?? 200;
    return Promise.resolve(
      new Response(status === 204 ? null : body, {
        status,
        headers: { 'content-type': typeof r.body === 'string' ? 'text/plain' : 'application/json', ...(r.headers ?? {}) },
      }),
    );
  };

  callsTo(pathname: string): RecordedCall[] {
    return this.calls.filter((c) => c.url.pathname === pathname);
  }
}
