import type { FastifyBaseLogger } from 'fastify';
import type { RetentionKind } from './domain.js';

// ------------------------------------------------------------------ audit
export interface AuditEventInput {
  tenantId: string | null;
  actorId: string | null;
  actorType: 'student' | 'professor' | 'coordinator' | 'admin' | 'system';
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
}

export interface AuditClient {
  /** Must never throw: audit delivery failures are logged, not propagated. */
  record(event: AuditEventInput): Promise<void>;
}

/** Sent as `x-internal-token` on every service-to-service call (integration stage §4). */
const internalHeaders = (token: string | undefined): Record<string, string> =>
  token ? { 'x-internal-token': token } : {};

export class HttpAuditClient implements AuditClient {
  constructor(
    private readonly baseUrl: string,
    private readonly log: FastifyBaseLogger,
    private readonly timeoutMs = 3000,
    private readonly internalToken?: string,
  ) {}

  async record(event: AuditEventInput): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/audit-events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders(this.internalToken) },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok)
        this.log.warn({ status: res.status, action: event.action }, 'audit service rejected event');
    } catch (err) {
      this.log.warn({ err, action: event.action }, 'audit service unreachable; event not recorded');
    }
  }
}

export class InMemoryAuditClient implements AuditClient {
  readonly events: AuditEventInput[] = [];
  record(event: AuditEventInput): Promise<void> {
    this.events.push(structuredClone(event));
    return Promise.resolve();
  }
}

export class UpstreamError extends Error {
  constructor(
    public readonly service: string,
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

async function call(
  service: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new UpstreamError(service, null, `${service} unreachable: ${(err as Error).message}`);
  }
}

// ------------------------------------------------------------------ class-section roster
export interface SectionRoster {
  classSectionId: string;
  institutionId: string;
  professorIds: string[];
  /** Students with an active enrollment. */
  studentIds: string[];
}

export interface RosterClient {
  /** Returns null when the section is unknown. */
  getRoster(classSectionId: string): Promise<SectionRoster | null>;
}

/** academic-integration `GET /v1/class-sections/{id}/roster`. */
export class HttpRosterClient implements RosterClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 5000,
    private readonly internalToken?: string,
  ) {}

  async getRoster(classSectionId: string): Promise<SectionRoster | null> {
    const res = await call(
      'academic-integration',
      `${this.baseUrl}/v1/class-sections/${encodeURIComponent(classSectionId)}/roster`,
      { headers: internalHeaders(this.internalToken) },
      this.timeoutMs,
    );
    if (res.status === 404) return null;
    if (!res.ok)
      throw new UpstreamError('academic-integration', res.status, `roster returned ${res.status}`);
    return (await res.json()) as SectionRoster;
  }
}

export class StaticRosterClient implements RosterClient {
  constructor(readonly rosters = new Map<string, SectionRoster>()) {}
  getRoster(classSectionId: string): Promise<SectionRoster | null> {
    const r = this.rosters.get(classSectionId);
    return Promise.resolve(r ? structuredClone(r) : null);
  }
}

// ------------------------------------------------------------------ retention targets
export interface RetentionCandidate {
  id: string;
  createdAt?: string;
  /** Used to match `recording` legal holds (for audio, the id itself is the recording session). */
  recordingSessionId?: string;
  classSectionId?: string;
  /** People the item is about / authored by — matched against `subject` holds. */
  subjectIds?: string[];
  /** Policy the item was captured under; the institution default is assumed when absent. */
  recordingPolicyId?: string;
}

export interface RetentionTarget {
  readonly name: string;
  readonly kinds: readonly RetentionKind[];
  candidates(query: {
    institutionId: string;
    olderThan: string;
    kind: RetentionKind;
  }): Promise<RetentionCandidate[]>;
  /** Returns the ids that were actually deleted. */
  delete(request: { ids: string[]; kind: RetentionKind; jobId: string }): Promise<string[]>;
}

interface CandidatesResponse {
  candidates?: RetentionCandidate[];
  items?: RetentionCandidate[];
  ids?: string[];
}

interface DeleteResponse {
  deletedIds?: string[];
  deleted?: string[];
}

/**
 * Data-owner endpoints (phase-4 contract §5):
 *   GET  /internal/v1/retention/candidates?institutionId&olderThan&kind → { candidates: [...] } (or { ids })
 *   POST /internal/v1/retention/delete { ids, kind, jobId }          → { deletedIds }
 */
export class HttpRetentionTarget implements RetentionTarget {
  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    readonly kinds: readonly RetentionKind[],
    private readonly timeoutMs = 30_000,
    private readonly internalToken?: string,
  ) {}

  async candidates(query: {
    institutionId: string;
    olderThan: string;
    kind: RetentionKind;
  }): Promise<RetentionCandidate[]> {
    const qs = new URLSearchParams(query);
    const res = await call(
      this.name,
      `${this.baseUrl}/internal/v1/retention/candidates?${qs.toString()}`,
      { headers: internalHeaders(this.internalToken) },
      this.timeoutMs,
    );
    if (!res.ok)
      throw new UpstreamError(this.name, res.status, `candidates returned ${res.status}`);
    const body = (await res.json()) as CandidatesResponse;
    return body.candidates ?? body.items ?? (body.ids ?? []).map((id) => ({ id }));
  }

  async delete(request: { ids: string[]; kind: RetentionKind; jobId: string }): Promise<string[]> {
    const res = await call(
      this.name,
      `${this.baseUrl}/internal/v1/retention/delete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders(this.internalToken) },
        body: JSON.stringify(request),
      },
      this.timeoutMs,
    );
    if (!res.ok) throw new UpstreamError(this.name, res.status, `delete returned ${res.status}`);
    const body = (await res.json()) as DeleteResponse;
    return body.deletedIds ?? body.deleted ?? [];
  }
}
