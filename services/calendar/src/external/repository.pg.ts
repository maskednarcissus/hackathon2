import pg from 'pg';
import type { ProviderId } from './providers.js';
import type {
  ConnectionStatus,
  EventLink,
  ExternalCalendarRepository,
  ExternalConnection,
  OAuthState,
} from './repository.js';

type Row = Record<string, unknown>;
const CONSUMER = 'calendar-external-sync';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : date(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const toConnection = (r: Row): ExternalConnection => ({
  id: String(r['id']),
  studentId: String(r['student_id']),
  provider: r['provider'] as ProviderId,
  status: r['status'] as ConnectionStatus,
  remoteCalendarId: strOrNull(r['remote_calendar_id']),
  tokenCiphertext: (r['token_ciphertext'] as Buffer | null) ?? null,
  tokenExpiresAt: dateOrNull(r['token_expires_at']),
  lastSyncAt: dateOrNull(r['last_sync_at']),
  lastError: strOrNull(r['last_error']),
  createdAt: date(r['created_at']),
  updatedAt: date(r['updated_at']),
});

const toLink = (r: Row): EventLink => ({
  connectionId: String(r['connection_id']),
  calendarEventId: String(r['calendar_event_id']),
  externalEventId: String(r['external_event_id']),
  syncedVersion: Number(r['synced_version']),
  syncedAt: date(r['synced_at']),
});

export class PgExternalCalendarRepository implements ExternalCalendarRepository {
  constructor(private readonly pool: pg.Pool) {}

  private async rows(sql: string, params: unknown[]): Promise<Row[]> {
    return (await this.pool.query(sql, params)).rows as Row[];
  }

  async saveConnection(c: ExternalConnection): Promise<void> {
    await this.pool.query(
      `INSERT INTO external_calendar_connections (id, student_id, provider, status, remote_calendar_id,
         token_ciphertext, token_expires_at, last_sync_at, last_error, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, remote_calendar_id = EXCLUDED.remote_calendar_id,
         token_ciphertext = EXCLUDED.token_ciphertext, token_expires_at = EXCLUDED.token_expires_at,
         last_sync_at = EXCLUDED.last_sync_at, last_error = EXCLUDED.last_error, updated_at = EXCLUDED.updated_at`,
      [
        c.id,
        c.studentId,
        c.provider,
        c.status,
        c.remoteCalendarId,
        c.tokenCiphertext,
        c.tokenExpiresAt,
        c.lastSyncAt,
        c.lastError,
        c.createdAt,
        c.updatedAt,
      ],
    );
  }

  async getConnection(id: string): Promise<ExternalConnection | undefined> {
    if (!UUID_RE.test(id)) return undefined;
    const r = (
      await this.rows('SELECT * FROM external_calendar_connections WHERE id = $1', [id])
    )[0];
    return r ? toConnection(r) : undefined;
  }

  async findConnection(
    studentId: string,
    provider: ProviderId,
  ): Promise<ExternalConnection | undefined> {
    const r = (
      await this.rows(
        'SELECT * FROM external_calendar_connections WHERE student_id = $1 AND provider = $2',
        [studentId, provider],
      )
    )[0];
    return r ? toConnection(r) : undefined;
  }

  async listConnections(f: {
    studentId?: string;
    status?: ConnectionStatus;
  }): Promise<ExternalConnection[]> {
    if (f.studentId !== undefined && !UUID_RE.test(f.studentId)) return [];
    return (
      await this.rows(
        `SELECT * FROM external_calendar_connections
         WHERE ($1::uuid IS NULL OR student_id = $1) AND ($2::text IS NULL OR status = $2)
         ORDER BY created_at`,
        [f.studentId ?? null, f.status ?? null],
      )
    ).map(toConnection);
  }

  async deleteConnection(id: string): Promise<void> {
    await this.pool.query('DELETE FROM external_calendar_connections WHERE id = $1', [id]);
  }

  async saveState(s: OAuthState): Promise<void> {
    await this.pool.query(
      `INSERT INTO external_calendar_oauth_states (state, student_id, provider, code_verifier, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [s.state, s.studentId, s.provider, s.codeVerifier, s.createdAt, s.expiresAt],
    );
  }

  async consumeState(state: string): Promise<OAuthState | undefined> {
    const r = (
      await this.rows('DELETE FROM external_calendar_oauth_states WHERE state = $1 RETURNING *', [
        state,
      ])
    )[0];
    return r
      ? {
          state: String(r['state']),
          studentId: String(r['student_id']),
          provider: r['provider'] as ProviderId,
          codeVerifier: String(r['code_verifier']),
          createdAt: date(r['created_at']),
          expiresAt: date(r['expires_at']),
        }
      : undefined;
  }

  async getLink(connectionId: string, calendarEventId: string): Promise<EventLink | undefined> {
    const r = (
      await this.rows(
        'SELECT * FROM external_calendar_event_links WHERE connection_id = $1 AND calendar_event_id = $2',
        [connectionId, calendarEventId],
      )
    )[0];
    return r ? toLink(r) : undefined;
  }

  async listLinks(connectionId: string): Promise<EventLink[]> {
    return (
      await this.rows('SELECT * FROM external_calendar_event_links WHERE connection_id = $1', [
        connectionId,
      ])
    ).map(toLink);
  }

  async saveLink(l: EventLink): Promise<void> {
    await this.pool.query(
      `INSERT INTO external_calendar_event_links (connection_id, calendar_event_id, external_event_id, synced_version, synced_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (connection_id, calendar_event_id) DO UPDATE SET external_event_id = EXCLUDED.external_event_id,
         synced_version = EXCLUDED.synced_version, synced_at = EXCLUDED.synced_at`,
      [l.connectionId, l.calendarEventId, l.externalEventId, l.syncedVersion, l.syncedAt],
    );
  }

  async deleteLink(connectionId: string, calendarEventId: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM external_calendar_event_links WHERE connection_id = $1 AND calendar_event_id = $2',
      [connectionId, calendarEventId],
    );
  }

  async markProcessed(eventId: string): Promise<boolean> {
    const result = await this.pool.query(
      'INSERT INTO processed_events (event_id, consumer) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [eventId, CONSUMER],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async unmarkProcessed(eventId: string): Promise<void> {
    await this.pool.query('DELETE FROM processed_events WHERE event_id = $1 AND consumer = $2', [
      eventId,
      CONSUMER,
    ]);
  }
}
