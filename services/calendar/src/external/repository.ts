import type { ProviderId } from './providers.js';

export type ConnectionStatus = 'pending' | 'active' | 'broken';

export interface ExternalConnection {
  id: string;
  studentId: string;
  provider: ProviderId;
  status: ConnectionStatus;
  /** Dedicated "Classroom Intelligence" calendar in the student's account. */
  remoteCalendarId: string | null;
  /** AES-256-GCM sealed JSON {accessToken, refreshToken, expiresAt}; AAD = connection id. */
  tokenCiphertext: Buffer | null;
  tokenExpiresAt: Date | null;
  lastSyncAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OAuthState {
  state: string;
  studentId: string;
  provider: ProviderId;
  codeVerifier: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface EventLink {
  connectionId: string;
  calendarEventId: string;
  externalEventId: string;
  syncedVersion: number;
  syncedAt: Date;
}

export interface ExternalCalendarRepository {
  saveConnection(c: ExternalConnection): Promise<void>;
  getConnection(id: string): Promise<ExternalConnection | undefined>;
  findConnection(studentId: string, provider: ProviderId): Promise<ExternalConnection | undefined>;
  listConnections(filter: {
    studentId?: string;
    status?: ConnectionStatus;
  }): Promise<ExternalConnection[]>;
  deleteConnection(id: string): Promise<void>;

  saveState(s: OAuthState): Promise<void>;
  /** Single use. */
  consumeState(state: string): Promise<OAuthState | undefined>;

  getLink(connectionId: string, calendarEventId: string): Promise<EventLink | undefined>;
  listLinks(connectionId: string): Promise<EventLink[]>;
  saveLink(link: EventLink): Promise<void>;
  deleteLink(connectionId: string, calendarEventId: string): Promise<void>;

  /** Idempotent event consumption: true the first time an event id is seen. */
  markProcessed(eventId: string): Promise<boolean>;
  /** Undo after a failed processing attempt so redelivery is handled. */
  unmarkProcessed(eventId: string): Promise<void>;
}

const copy = <T extends object>(v: T): T => ({ ...v });

export class InMemoryExternalCalendarRepository implements ExternalCalendarRepository {
  private readonly connections = new Map<string, ExternalConnection>();
  private readonly states = new Map<string, OAuthState>();
  private readonly links = new Map<string, EventLink>();
  private readonly processed = new Set<string>();

  async saveConnection(c: ExternalConnection): Promise<void> {
    this.connections.set(c.id, copy(c));
  }
  async getConnection(id: string): Promise<ExternalConnection | undefined> {
    const c = this.connections.get(id);
    return c ? copy(c) : undefined;
  }
  async findConnection(
    studentId: string,
    provider: ProviderId,
  ): Promise<ExternalConnection | undefined> {
    for (const c of this.connections.values()) {
      if (c.studentId === studentId && c.provider === provider) return copy(c);
    }
    return undefined;
  }
  async listConnections(f: {
    studentId?: string;
    status?: ConnectionStatus;
  }): Promise<ExternalConnection[]> {
    return [...this.connections.values()]
      .filter(
        (c) =>
          (f.studentId === undefined || c.studentId === f.studentId) &&
          (f.status === undefined || c.status === f.status),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(copy);
  }
  async deleteConnection(id: string): Promise<void> {
    this.connections.delete(id);
    for (const [k, l] of this.links) if (l.connectionId === id) this.links.delete(k);
  }
  async saveState(s: OAuthState): Promise<void> {
    this.states.set(s.state, copy(s));
  }
  async consumeState(state: string): Promise<OAuthState | undefined> {
    const s = this.states.get(state);
    this.states.delete(state);
    return s;
  }
  async getLink(connectionId: string, calendarEventId: string): Promise<EventLink | undefined> {
    const l = this.links.get(`${connectionId}|${calendarEventId}`);
    return l ? copy(l) : undefined;
  }
  async listLinks(connectionId: string): Promise<EventLink[]> {
    return [...this.links.values()].filter((l) => l.connectionId === connectionId).map(copy);
  }
  async saveLink(link: EventLink): Promise<void> {
    this.links.set(`${link.connectionId}|${link.calendarEventId}`, copy(link));
  }
  async deleteLink(connectionId: string, calendarEventId: string): Promise<void> {
    this.links.delete(`${connectionId}|${calendarEventId}`);
  }
  async markProcessed(eventId: string): Promise<boolean> {
    if (this.processed.has(eventId)) return false;
    this.processed.add(eventId);
    return true;
  }
  async unmarkProcessed(eventId: string): Promise<void> {
    this.processed.delete(eventId);
  }
}
