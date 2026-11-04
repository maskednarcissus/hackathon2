/**
 * External calendar connections and synchronisation (Phase 6 §6.9).
 *
 * - connect: OAuth 2.0 authorization code + PKCE (S256) + single-use state (10 min).
 * - tokens: AES-256-GCM sealed at rest, refreshed 60 s before expiry; `invalid_grant` or a 401 after refresh
 *   marks the connection `broken` (the student must reconnect) — nothing is retried against a dead grant.
 * - sync: per (connection, calendar event) link with the remote id and the synced version → idempotent;
 *   cancelled events and events the student can no longer see are deleted remotely.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { CalendarEvent } from '../domain.js';
import type { CalendarRepository } from '../repository.js';
import type { Clock } from '../service.js';
import type { TokenCipher } from './crypto.js';
import {
  ProviderAuthError,
  type CalendarProvider,
  type ProviderId,
  type ProviderTokens,
  type RemoteEvent,
} from './providers.js';
import type { EventLink, ExternalCalendarRepository, ExternalConnection } from './repository.js';

export const DEDICATED_CALENDAR_NAME = 'Classroom Intelligence';
const STATE_TTL_MS = 10 * 60_000;
const REFRESH_SKEW_MS = 60_000;

const DURATION_MINUTES: Partial<Record<CalendarEvent['type'], number>> = {
  examination: 120,
  quiz: 60,
  presentation: 90,
};

export class ExternalCalendarError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ExternalCalendarDeps {
  repo: ExternalCalendarRepository;
  providers: Partial<Record<ProviderId, CalendarProvider>>;
  cipher: TokenCipher;
  /** Public callback base, e.g. https://api.example/ → {base}/v1/oauth/{provider}/callback */
  redirectBaseUrl: string;
}

export interface SyncStats {
  upserted: number;
  deleted: number;
  skipped: number;
  failed: number;
  broken: number;
}

const emptyStats = (): SyncStats => ({ upserted: 0, deleted: 0, skipped: 0, failed: 0, broken: 0 });
const add = (a: SyncStats, b: SyncStats): SyncStats => ({
  upserted: a.upserted + b.upserted,
  deleted: a.deleted + b.deleted,
  skipped: a.skipped + b.skipped,
  failed: a.failed + b.failed,
  broken: a.broken + b.broken,
});

export interface PublicConnection {
  id: string;
  studentId: string;
  provider: ProviderId;
  status: ExternalConnection['status'];
  remoteCalendarId: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export const toPublic = (c: ExternalConnection): PublicConnection => ({
  id: c.id,
  studentId: c.studentId,
  provider: c.provider,
  status: c.status,
  remoteCalendarId: c.remoteCalendarId,
  lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
  lastError: c.lastError,
  createdAt: c.createdAt.toISOString(),
});

export function toRemoteEvent(
  event: CalendarEvent,
  connectionId: string,
  courseName: string | null,
): RemoteEvent {
  const lines = [
    event.description ?? '',
    courseName ? `Disciplina: ${courseName}` : '',
    event.provenance
      ? `Anunciado em aula: “${event.provenance.quote}” (confirmado pelo professor)`
      : '',
    'Sincronizado pelo Classroom Intelligence — não edite aqui; alterações são sobrescritas.',
  ].filter((l) => l.length > 0);
  return {
    idempotencyKey: `${connectionId}:${event.id}`,
    title: courseName ? `${event.title} · ${courseName}` : event.title,
    description: lines.join('\n'),
    timezone: event.timezone,
    date: event.eventDate,
    startTime: event.eventTime,
    durationMinutes: DURATION_MINUTES[event.type] ?? 60,
  };
}

export class ExternalCalendarService {
  constructor(
    private readonly deps: ExternalCalendarDeps,
    private readonly calendar: CalendarRepository,
    private readonly clock: Clock,
  ) {}

  private provider(id: ProviderId): CalendarProvider {
    const p = this.deps.providers[id];
    if (!p)
      throw new ExternalCalendarError(
        404,
        'provider_not_configured',
        `${id} calendar is not configured`,
      );
    return p;
  }

  redirectUri(provider: ProviderId): string {
    return `${this.deps.redirectBaseUrl.replace(/\/$/, '')}/v1/oauth/${provider}/callback`;
  }

  async connect(
    studentId: string,
    providerId: ProviderId,
  ): Promise<{ authorizationUrl: string; state: string }> {
    const provider = this.provider(providerId);
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(48).toString('base64url');
    const now = this.clock.now();
    await this.deps.repo.saveState({
      state,
      studentId,
      provider: providerId,
      codeVerifier,
      createdAt: now,
      expiresAt: new Date(now.getTime() + STATE_TTL_MS),
    });
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    return {
      state,
      authorizationUrl: provider.authorizationUrl({
        state,
        codeChallenge,
        redirectUri: this.redirectUri(providerId),
      }),
    };
  }

  async callback(
    providerId: ProviderId,
    code: string,
    state: string,
  ): Promise<{ connection: PublicConnection; stats: SyncStats }> {
    const stored = await this.deps.repo.consumeState(state);
    if (!stored || stored.provider !== providerId) {
      throw new ExternalCalendarError(400, 'invalid_state', 'Unknown or already used state');
    }
    if (stored.expiresAt.getTime() <= this.clock.now().getTime()) {
      throw new ExternalCalendarError(400, 'state_expired', 'Authorization request expired');
    }
    const provider = this.provider(providerId);
    let tokens: ProviderTokens;
    try {
      tokens = await provider.exchangeCode({
        code,
        codeVerifier: stored.codeVerifier,
        redirectUri: this.redirectUri(providerId),
      });
    } catch (err) {
      throw new ExternalCalendarError(
        400,
        'token_exchange_failed',
        err instanceof Error ? err.message : String(err),
      );
    }

    const now = this.clock.now();
    const existing = await this.deps.repo.findConnection(stored.studentId, providerId);
    const connection: ExternalConnection = existing
      ? { ...existing, status: 'active', lastError: null, updatedAt: now }
      : {
          id: randomUUID(),
          studentId: stored.studentId,
          provider: providerId,
          status: 'active',
          remoteCalendarId: null,
          tokenCiphertext: null,
          tokenExpiresAt: null,
          lastSyncAt: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        };
    // A reconnect may not return a refresh token (Google only issues it on first consent).
    const previous = existing ? this.openTokens(existing) : undefined;
    const merged: ProviderTokens = {
      ...tokens,
      refreshToken: tokens.refreshToken ?? previous?.refreshToken ?? null,
    };
    this.sealInto(connection, merged);
    if (connection.remoteCalendarId === null) {
      connection.remoteCalendarId = await provider.createCalendar(
        merged.accessToken,
        DEDICATED_CALENDAR_NAME,
        'America/Sao_Paulo',
      );
    }
    await this.deps.repo.saveConnection(connection);
    const stats = await this.reconcileConnection(connection.id);
    const fresh = await this.deps.repo.getConnection(connection.id);
    return { connection: toPublic(fresh ?? connection), stats };
  }

  async list(studentId: string): Promise<PublicConnection[]> {
    return (await this.deps.repo.listConnections({ studentId })).map(toPublic);
  }

  /** Removes the remote dedicated calendar (best effort), revokes the grant and deletes local state. */
  async disconnect(connectionId: string): Promise<{ remoteCalendarDeleted: boolean }> {
    const connection = await this.deps.repo.getConnection(connectionId);
    if (!connection) throw new ExternalCalendarError(404, 'not_found', 'Connection not found');
    const provider = this.deps.providers[connection.provider];
    let remoteCalendarDeleted = false;
    if (provider && connection.status !== 'broken') {
      try {
        const accessToken = await this.accessToken(connection, provider);
        if (connection.remoteCalendarId) {
          await provider.deleteCalendar(accessToken, connection.remoteCalendarId);
          remoteCalendarDeleted = true;
        }
        const tokens = this.openTokens(connection);
        await provider.revoke(tokens?.refreshToken ?? accessToken);
      } catch {
        // The grant may already be gone; local data is removed regardless.
      }
    }
    await this.deps.repo.deleteConnection(connectionId);
    return { remoteCalendarDeleted };
  }

  /** DSR deletion: every connection of the student, remote calendars included. */
  async eraseStudent(
    studentId: string,
  ): Promise<{ connectionsRemoved: number; remoteCalendarsDeleted: number }> {
    const connections = await this.deps.repo.listConnections({ studentId });
    let remoteCalendarsDeleted = 0;
    for (const c of connections) {
      if ((await this.disconnect(c.id)).remoteCalendarDeleted) remoteCalendarsDeleted += 1;
    }
    return { connectionsRemoved: connections.length, remoteCalendarsDeleted };
  }

  // ---- tokens -----------------------------------------------------------------

  private sealInto(connection: ExternalConnection, tokens: ProviderTokens): void {
    connection.tokenCiphertext = this.deps.cipher.seal(
      connection.id,
      JSON.stringify({ ...tokens, expiresAt: tokens.expiresAt.toISOString() }),
    );
    connection.tokenExpiresAt = tokens.expiresAt;
  }

  private openTokens(connection: ExternalConnection): ProviderTokens | undefined {
    if (!connection.tokenCiphertext) return undefined;
    try {
      const raw = JSON.parse(this.deps.cipher.open(connection.id, connection.tokenCiphertext)) as {
        accessToken: string;
        refreshToken: string | null;
        expiresAt: string;
      };
      return {
        accessToken: raw.accessToken,
        refreshToken: raw.refreshToken,
        expiresAt: new Date(raw.expiresAt),
      };
    } catch {
      return undefined;
    }
  }

  private async markBroken(connection: ExternalConnection, reason: string): Promise<void> {
    connection.status = 'broken';
    connection.lastError = reason;
    connection.tokenCiphertext = null; // a dead grant is useless; do not keep it
    connection.tokenExpiresAt = null;
    connection.updatedAt = this.clock.now();
    await this.deps.repo.saveConnection(connection);
  }

  private async accessToken(
    connection: ExternalConnection,
    provider: CalendarProvider,
    forceRefresh = false,
  ): Promise<string> {
    const tokens = this.openTokens(connection);
    if (!tokens) {
      await this.markBroken(connection, 'tokens_unavailable');
      throw new ProviderAuthError('tokens unavailable');
    }
    const now = this.clock.now().getTime();
    if (!forceRefresh && tokens.expiresAt.getTime() - REFRESH_SKEW_MS > now)
      return tokens.accessToken;
    if (!tokens.refreshToken) {
      await this.markBroken(connection, 'no_refresh_token');
      throw new ProviderAuthError('no refresh token');
    }
    try {
      const refreshed = await provider.refresh(tokens.refreshToken);
      this.sealInto(connection, {
        ...refreshed,
        refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
      });
      connection.updatedAt = this.clock.now();
      await this.deps.repo.saveConnection(connection);
      return refreshed.accessToken;
    } catch (err) {
      if (err instanceof ProviderAuthError) await this.markBroken(connection, 'invalid_grant');
      throw err;
    }
  }

  /** Runs a provider call; on a 401 refreshes once and retries; a second auth failure breaks the connection. */
  private async withToken<T>(
    connection: ExternalConnection,
    provider: CalendarProvider,
    fn: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    const token = await this.accessToken(connection, provider);
    try {
      return await fn(token);
    } catch (err) {
      if (!(err instanceof ProviderAuthError)) throw err;
      const refreshed = await this.accessToken(connection, provider, true);
      try {
        return await fn(refreshed);
      } catch (again) {
        if (again instanceof ProviderAuthError) await this.markBroken(connection, 'unauthorized');
        throw again;
      }
    }
  }

  // ---- sync -------------------------------------------------------------------

  private async syncOne(
    connection: ExternalConnection,
    event: CalendarEvent,
    visible: boolean,
  ): Promise<SyncStats> {
    const stats = emptyStats();
    const provider = this.deps.providers[connection.provider];
    if (!provider || connection.status !== 'active' || !connection.remoteCalendarId) {
      stats.skipped += 1;
      return stats;
    }
    const calendarId = connection.remoteCalendarId;
    const link = await this.deps.repo.getLink(connection.id, event.id);
    try {
      if (event.status === 'cancelled' || !visible) {
        if (link) {
          await this.withToken(connection, provider, (t) =>
            provider.deleteEvent(t, calendarId, link.externalEventId),
          );
          await this.deps.repo.deleteLink(connection.id, event.id);
          stats.deleted += 1;
        } else stats.skipped += 1;
        return stats;
      }
      if (link && link.syncedVersion >= event.version) {
        stats.skipped += 1;
        return stats;
      }
      const section = await this.calendar.getSection(event.classSectionId);
      const remote = toRemoteEvent(event, connection.id, section?.courseName ?? null);
      const externalEventId = await this.withToken(connection, provider, (t) =>
        provider.upsertEvent(t, calendarId, link?.externalEventId ?? null, remote),
      );
      const saved: EventLink = {
        connectionId: connection.id,
        calendarEventId: event.id,
        externalEventId,
        syncedVersion: event.version,
        syncedAt: this.clock.now(),
      };
      await this.deps.repo.saveLink(saved);
      stats.upserted += 1;
    } catch (err) {
      if (err instanceof ProviderAuthError) stats.broken += 1;
      else {
        stats.failed += 1;
        connection.lastError = err instanceof Error ? err.message : String(err);
        connection.updatedAt = this.clock.now();
        await this.deps.repo.saveConnection(connection);
      }
    }
    return stats;
  }

  /** Handler for calendar.event_published / calendar.event_updated: syncs the event for enrolled students. */
  async syncEvent(event: CalendarEvent): Promise<SyncStats> {
    const current = (await this.calendar.getEvent(event.id)) ?? event;
    const students = await this.calendar.studentsOf(current.classSectionId);
    let stats = emptyStats();
    for (const studentId of students) {
      for (const connection of await this.deps.repo.listConnections({
        studentId,
        status: 'active',
      })) {
        stats = add(stats, await this.syncOne(connection, current, true));
      }
    }
    return stats;
  }

  async reconcileConnection(connectionId: string): Promise<SyncStats> {
    const connection = await this.deps.repo.getConnection(connectionId);
    if (!connection || connection.status !== 'active') return emptyStats();
    const sections = await this.calendar.sectionsOfStudent(connection.studentId);
    const events = sections.length
      ? await this.calendar.listEvents({ classSectionIds: sections, includeCancelled: true })
      : [];
    let stats = emptyStats();
    const seen = new Set<string>();
    for (const event of events) {
      seen.add(event.id);
      stats = add(stats, await this.syncOne(connection, event, true));
      if (connection.status !== 'active') return stats;
    }
    // Links to events the student can no longer see (unenrolled): remove remotely.
    for (const link of await this.deps.repo.listLinks(connection.id)) {
      if (seen.has(link.calendarEventId)) continue;
      const event = await this.calendar.getEvent(link.calendarEventId);
      if (event) stats = add(stats, await this.syncOne(connection, event, false));
      else await this.deps.repo.deleteLink(connection.id, link.calendarEventId);
    }
    if (connection.status === 'active') {
      connection.lastSyncAt = this.clock.now();
      if (stats.failed === 0) connection.lastError = null;
      connection.updatedAt = this.clock.now();
      await this.deps.repo.saveConnection(connection);
    }
    return stats;
  }

  /** Nightly reconcile (scheduler) — all active connections, or one student's. */
  async reconcile(studentId?: string): Promise<SyncStats & { connections: number }> {
    const connections = await this.deps.repo.listConnections({
      status: 'active',
      ...(studentId !== undefined ? { studentId } : {}),
    });
    let stats = emptyStats();
    for (const c of connections) stats = add(stats, await this.reconcileConnection(c.id));
    return { ...stats, connections: connections.length };
  }
}
