/**
 * External calendar providers (Phase 6 §6.9): Google Calendar API v3 and Microsoft Graph v1.0.
 * All HTTP goes through an injectable fetch so tests use a fake provider (no live calls).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PROVIDERS = ['google', 'microsoft'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export interface ProviderTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
}

/** What we write into the student's calendar. */
export interface RemoteEvent {
  /** Stable key for idempotent creation (Google event id / Graph transactionId). */
  idempotencyKey: string;
  title: string;
  description: string;
  timezone: string;
  /** All-day when `startTime` is null. */
  date: string;
  startTime: string | null;
  durationMinutes: number;
}

/** The grant is no longer valid (revoked by the user, expired refresh token…): connection is broken. */
export class ProviderAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderAuthError';
  }
}

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}

export interface CalendarProvider {
  readonly id: ProviderId;
  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<ProviderTokens>;
  refresh(refreshToken: string): Promise<ProviderTokens>;
  /** Dedicated "Classroom Intelligence" calendar. */
  createCalendar(accessToken: string, name: string, timezone: string): Promise<string>;
  deleteCalendar(accessToken: string, calendarId: string): Promise<void>;
  /** Insert (when externalEventId is null) or patch; returns the remote event id. */
  upsertEvent(
    accessToken: string,
    calendarId: string,
    externalEventId: string | null,
    event: RemoteEvent,
  ): Promise<string>;
  /** 404/410 are treated as success (already gone). */
  deleteEvent(accessToken: string, calendarId: string, externalEventId: string): Promise<void>;
  revoke(token: string): Promise<void>;
}

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  /** Clock for token expiry (injectable for tests). */
  now?: () => Date;
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().int().positive().default(3600),
});

const IdResponse = z.object({ id: z.string().min(1) });

function addMinutes(date: string, time: string, minutes: number): { date: string; time: string } {
  const [h = 0, m = 0] = time.split(':').map(Number);
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCMinutes(h * 60 + m + minutes);
  return { date: base.toISOString().slice(0, 10), time: base.toISOString().slice(11, 16) };
}

const nextDay = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

abstract class OAuthProvider implements CalendarProvider {
  abstract readonly id: ProviderId;
  protected abstract readonly authorizeEndpoint: string;
  protected abstract readonly tokenEndpoint: string;
  protected abstract readonly scope: string;
  protected readonly doFetch: typeof fetch;

  constructor(protected readonly config: OAuthClientConfig) {
    this.doFetch = config.fetch ?? globalThis.fetch;
  }

  protected extraAuthParams(): Record<string, string> {
    return {};
  }

  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL(this.authorizeEndpoint);
    const params: Record<string, string> = {
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: input.redirectUri,
      scope: this.scope,
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      ...this.extraAuthParams(),
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  private async token(form: Record<string, string>): Promise<ProviderTokens> {
    const res = await this.doFetch(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        ...form,
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // RFC 6749 §5.2: invalid_grant = revoked/expired grant → the connection must be re-authorised.
      if (body['error'] === 'invalid_grant' || res.status === 401) {
        throw new ProviderAuthError(`token endpoint: ${String(body['error'] ?? res.status)}`);
      }
      throw new ProviderRequestError(`token endpoint HTTP ${res.status}`, res.status);
    }
    const parsed = TokenResponse.parse(body);
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token ?? null,
      expiresAt: new Date((this.config.now?.() ?? new Date()).getTime() + parsed.expires_in * 1000),
    };
  }

  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<ProviderTokens> {
    return this.token({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    });
  }

  refresh(refreshToken: string): Promise<ProviderTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  protected async api(
    accessToken: string,
    method: string,
    url: string,
    body?: unknown,
    okStatuses: number[] = [],
  ): Promise<Response> {
    const res = await this.doFetch(url, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.ok || okStatuses.includes(res.status)) return res;
    if (res.status === 401) throw new ProviderAuthError(`${this.id} API 401`);
    throw new ProviderRequestError(`${this.id} API ${method} HTTP ${res.status}`, res.status);
  }

  abstract createCalendar(accessToken: string, name: string, timezone: string): Promise<string>;
  abstract deleteCalendar(accessToken: string, calendarId: string): Promise<void>;
  abstract upsertEvent(
    accessToken: string,
    calendarId: string,
    externalEventId: string | null,
    event: RemoteEvent,
  ): Promise<string>;
  abstract deleteEvent(
    accessToken: string,
    calendarId: string,
    externalEventId: string,
  ): Promise<void>;
  abstract revoke(token: string): Promise<void>;
}

export class GoogleCalendarProvider extends OAuthProvider {
  readonly id = 'google' as const;
  protected readonly authorizeEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
  protected readonly tokenEndpoint = 'https://oauth2.googleapis.com/token';
  /** Narrowest scope: only calendars created by this app. */
  protected readonly scope = 'https://www.googleapis.com/auth/calendar.app.created';
  private readonly base = 'https://www.googleapis.com/calendar/v3';

  protected override extraAuthParams(): Record<string, string> {
    return { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' };
  }

  /** Google event ids: base32hex [a-v0-9], 5–1024 chars → deterministic id from the idempotency key. */
  static eventId(key: string): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 40);
  }

  private body(e: RemoteEvent): Record<string, unknown> {
    const timing =
      e.startTime === null
        ? { start: { date: e.date }, end: { date: nextDay(e.date) } }
        : ((): Record<string, unknown> => {
            const end = addMinutes(e.date, e.startTime, e.durationMinutes);
            return {
              start: { dateTime: `${e.date}T${e.startTime}:00`, timeZone: e.timezone },
              end: { dateTime: `${end.date}T${end.time}:00`, timeZone: e.timezone },
            };
          })();
    return { summary: e.title, description: e.description, ...timing, status: 'confirmed' };
  }

  async createCalendar(accessToken: string, name: string, timezone: string): Promise<string> {
    const res = await this.api(accessToken, 'POST', `${this.base}/calendars`, {
      summary: name,
      timeZone: timezone,
    });
    return IdResponse.parse(await res.json()).id;
  }

  async deleteCalendar(accessToken: string, calendarId: string): Promise<void> {
    await this.api(
      accessToken,
      'DELETE',
      `${this.base}/calendars/${encodeURIComponent(calendarId)}`,
      undefined,
      [404, 410],
    );
  }

  async upsertEvent(
    accessToken: string,
    calendarId: string,
    externalEventId: string | null,
    event: RemoteEvent,
  ): Promise<string> {
    const events = `${this.base}/calendars/${encodeURIComponent(calendarId)}/events`;
    if (externalEventId !== null) {
      const res = await this.api(
        accessToken,
        'PATCH',
        `${events}/${encodeURIComponent(externalEventId)}`,
        this.body(event),
        [404, 410],
      );
      if (res.ok) return externalEventId;
      // Deleted remotely: recreate below.
    }
    const id = GoogleCalendarProvider.eventId(event.idempotencyKey);
    const res = await this.api(accessToken, 'POST', events, { id, ...this.body(event) }, [409]);
    if (res.status === 409) {
      // Created by a previous (retried) attempt: patch it instead — idempotent insert.
      await this.api(accessToken, 'PATCH', `${events}/${id}`, this.body(event));
    }
    return id;
  }

  async deleteEvent(
    accessToken: string,
    calendarId: string,
    externalEventId: string,
  ): Promise<void> {
    await this.api(
      accessToken,
      'DELETE',
      `${this.base}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalEventId)}`,
      undefined,
      [404, 410],
    );
  }

  async revoke(token: string): Promise<void> {
    await this.doFetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: 'POST',
    }).catch(() => undefined);
  }
}

export class MicrosoftCalendarProvider extends OAuthProvider {
  readonly id = 'microsoft' as const;
  protected readonly authorizeEndpoint: string;
  protected readonly tokenEndpoint: string;
  protected readonly scope = 'offline_access Calendars.ReadWrite';
  private readonly base = 'https://graph.microsoft.com/v1.0';

  constructor(config: OAuthClientConfig & { tenant?: string }) {
    super(config);
    const tenant = config.tenant ?? 'common';
    this.authorizeEndpoint = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
    this.tokenEndpoint = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  }

  private body(e: RemoteEvent): Record<string, unknown> {
    const start = e.startTime ?? '00:00';
    const end =
      e.startTime === null
        ? { date: nextDay(e.date), time: '00:00' }
        : addMinutes(e.date, e.startTime, e.durationMinutes);
    return {
      subject: e.title,
      body: { contentType: 'text', content: e.description },
      isAllDay: e.startTime === null,
      start: { dateTime: `${e.date}T${start}:00`, timeZone: e.timezone },
      end: { dateTime: `${end.date}T${end.time}:00`, timeZone: e.timezone },
    };
  }

  async createCalendar(accessToken: string, name: string): Promise<string> {
    const res = await this.api(accessToken, 'POST', `${this.base}/me/calendars`, { name });
    return IdResponse.parse(await res.json()).id;
  }

  async deleteCalendar(accessToken: string, calendarId: string): Promise<void> {
    await this.api(
      accessToken,
      'DELETE',
      `${this.base}/me/calendars/${encodeURIComponent(calendarId)}`,
      undefined,
      [404, 410],
    );
  }

  async upsertEvent(
    accessToken: string,
    calendarId: string,
    externalEventId: string | null,
    event: RemoteEvent,
  ): Promise<string> {
    if (externalEventId !== null) {
      const res = await this.api(
        accessToken,
        'PATCH',
        `${this.base}/me/events/${encodeURIComponent(externalEventId)}`,
        this.body(event),
        [404, 410],
      );
      if (res.ok) return externalEventId;
    }
    // transactionId makes Graph de-duplicate retried creations.
    const res = await this.api(
      accessToken,
      'POST',
      `${this.base}/me/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        ...this.body(event),
        transactionId: createHash('sha256').update(event.idempotencyKey).digest('hex').slice(0, 36),
      },
    );
    return IdResponse.parse(await res.json()).id;
  }

  async deleteEvent(
    accessToken: string,
    _calendarId: string,
    externalEventId: string,
  ): Promise<void> {
    await this.api(
      accessToken,
      'DELETE',
      `${this.base}/me/events/${encodeURIComponent(externalEventId)}`,
      undefined,
      [404, 410],
    );
  }

  /** Graph has no token revocation endpoint for delegated tokens; deleting the calendar is the cleanup. */
  async revoke(): Promise<void> {
    return Promise.resolve();
  }
}
