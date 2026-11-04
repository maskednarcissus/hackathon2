/**
 * In-process fake of the Google OAuth/Calendar API and Microsoft identity/Graph endpoints used by the
 * external-calendar adapters. Served through an injected fetch — no network.
 */
import { createHash } from 'node:crypto';

export interface FakeEvent {
  id: string;
  calendarId: string;
  body: Record<string, unknown>;
}

export interface RecordedRequest {
  method: string;
  url: string;
  body: string | undefined;
}

export class FakeCalendarProvider {
  readonly requests: RecordedRequest[] = [];
  readonly calendars = new Map<string, Record<string, unknown>>();
  readonly events = new Map<string, FakeEvent>();
  readonly revoked: string[] = [];
  private readonly codes = new Map<string, { challenge: string; redirectUri: string }>();
  private readonly validAccess = new Set<string>();
  private refreshValid = true;
  private seq = 0;

  constructor(readonly kind: 'google' | 'microsoft') {}

  /** Simulates the user consenting at the authorization URL; returns the code the browser would carry. */
  consent(authorizationUrl: string): { code: string; state: string } {
    const url = new URL(authorizationUrl);
    const code = `code-${++this.seq}`;
    this.codes.set(code, {
      challenge: url.searchParams.get('code_challenge') ?? '',
      redirectUri: url.searchParams.get('redirect_uri') ?? '',
    });
    return { code, state: url.searchParams.get('state') ?? '' };
  }

  /** The user revoked the app: refresh tokens now fail with invalid_grant. */
  revokeGrant(): void {
    this.refreshValid = false;
    this.validAccess.clear();
  }

  /** Access tokens stop working (server-side expiry) while the refresh token stays valid. */
  invalidateAccessTokens(): void {
    this.validAccess.clear();
  }

  eventsIn(calendarId: string): FakeEvent[] {
    return [...this.events.values()].filter((e) => e.calendarId === calendarId);
  }

  calls(method: string, contains: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method && r.url.includes(contains));
  }

  private json(status: number, body: unknown): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  private issue(): Response {
    const access = `${this.kind}-at-${++this.seq}`;
    this.validAccess.add(access);
    return this.json(200, {
      access_token: access,
      refresh_token: `${this.kind}-rt`,
      expires_in: 3600,
      token_type: 'Bearer',
    });
  }

  readonly fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : undefined;
    this.requests.push({ method, url: url.toString(), body });

    if (url.pathname.endsWith('/token')) {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        const entry = this.codes.get(form.get('code') ?? '');
        const challenge = createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url');
        if (
          !entry ||
          entry.challenge !== challenge ||
          entry.redirectUri !== form.get('redirect_uri')
        ) {
          return this.json(400, { error: 'invalid_grant' });
        }
        this.codes.delete(form.get('code') ?? '');
        return this.issue();
      }
      if (form.get('grant_type') === 'refresh_token') {
        return this.refreshValid ? this.issue() : this.json(400, { error: 'invalid_grant' });
      }
      return this.json(400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname.endsWith('/revoke')) {
      this.revoked.push(url.searchParams.get('token') ?? '');
      return this.json(200, {});
    }

    const auth = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!this.validAccess.has(auth)) return this.json(401, { error: { code: 'unauthenticated' } });
    const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    const path = url.pathname;

    // Calendars
    const calendarCreate =
      this.kind === 'google' ? /\/calendar\/v3\/calendars$/ : /\/v1\.0\/me\/calendars$/;
    if (method === 'POST' && calendarCreate.test(path)) {
      const id = `${this.kind}-cal-${++this.seq}`;
      this.calendars.set(id, parsed);
      return this.json(200, { id, ...parsed });
    }
    const calendarDelete =
      this.kind === 'google' ? /\/calendars\/([^/]+)$/ : /\/me\/calendars\/([^/]+)$/;
    const del = calendarDelete.exec(path);
    if (method === 'DELETE' && del) {
      const id = decodeURIComponent(del[1] ?? '');
      if (!this.calendars.delete(id)) return this.json(404, {});
      for (const [k, e] of this.events) if (e.calendarId === id) this.events.delete(k);
      return this.json(204, null);
    }

    // Events
    if (this.kind === 'google') {
      const m = /\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
      if (m) {
        const calendarId = decodeURIComponent(m[1] ?? '');
        const eventId = m[2] ? decodeURIComponent(m[2]) : undefined;
        if (method === 'POST') {
          const id = String(parsed['id']);
          if (this.events.has(id)) return this.json(409, { error: { code: 409 } });
          this.events.set(id, { id, calendarId, body: parsed });
          return this.json(200, { id });
        }
        const existing = eventId ? this.events.get(eventId) : undefined;
        if (!existing) return this.json(404, {});
        if (method === 'PATCH') {
          existing.body = { ...existing.body, ...parsed };
          return this.json(200, { id: existing.id });
        }
        if (method === 'DELETE') {
          this.events.delete(existing.id);
          return this.json(204, null);
        }
      }
    } else {
      const create = /\/me\/calendars\/([^/]+)\/events$/.exec(path);
      if (method === 'POST' && create) {
        const calendarId = decodeURIComponent(create[1] ?? '');
        const tx = String(parsed['transactionId']);
        const dup = [...this.events.values()].find((e) => e.body['transactionId'] === tx);
        if (dup) return this.json(201, { id: dup.id });
        const id = `${this.kind}-evt-${++this.seq}`;
        this.events.set(id, { id, calendarId, body: parsed });
        return this.json(201, { id });
      }
      const one = /\/me\/events\/([^/]+)$/.exec(path);
      if (one) {
        const existing = this.events.get(decodeURIComponent(one[1] ?? ''));
        if (!existing) return this.json(404, {});
        if (method === 'PATCH') {
          existing.body = { ...existing.body, ...parsed };
          return this.json(200, { id: existing.id });
        }
        if (method === 'DELETE') {
          this.events.delete(existing.id);
          return this.json(204, null);
        }
      }
    }
    return this.json(404, { error: 'not_found', path });
  }) as typeof fetch;
}
