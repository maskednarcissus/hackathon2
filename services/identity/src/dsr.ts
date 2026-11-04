/**
 * LGPD data subject rights (DSR) workflow — Phase 4 deliverable 4.11.
 * Contract: docs/architecture/phase-4-institutional-intelligence.md §6.
 *
 * State machine:
 *   received ──verify──▶ verifying ──execute──▶ in_progress ──(all handlers ok)──▶ completed
 *      │                    │                       │  └─(some handler failed)─▶ stays in_progress;
 *      └──────reject────────┴──────reject───▶ rejected    execute again re-runs only failed handlers
 *
 * `verifying` means the subject's identity has been verified and the request awaits execution.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Repositories, UserRecord } from './repositories.js';

export const DSR_TYPES = [
  'access',
  'correction',
  'deletion',
  'anonymization',
  'restriction',
] as const;
export type DsrType = (typeof DSR_TYPES)[number];
export const DSR_STATUSES = [
  'received',
  'verifying',
  'in_progress',
  'completed',
  'rejected',
] as const;
export type DsrStatus = (typeof DSR_STATUSES)[number];
export const SUBJECT_TYPES = ['student', 'professor', 'user'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];
export const DSR_CHANNELS = ['web', 'email', 'in_person', 'phone', 'letter', 'other'] as const;
export type DsrChannel = (typeof DSR_CHANNELS)[number];

/** LGPD art. 19 — response within 15 days. */
export const DSR_DUE_DAYS = 15;

export interface DsrRequest {
  id: string;
  institutionId: string;
  subjectType: SubjectType;
  subjectId: string;
  /** Identity account of the subject, resolved at creation. */
  subjectUserId: string;
  type: DsrType;
  status: DsrStatus;
  requestedBy: string;
  channel: DsrChannel;
  details: Record<string, unknown> | null;
  receivedAt: Date;
  dueAt: Date;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  verificationMethod: string | null;
  completedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  exportUri: string | null;
  executionAttempts: number;
  updatedAt: Date;
}

export type ServiceResultStatus = 'pending' | 'completed' | 'not_applicable' | 'failed';

export interface DsrServiceResult {
  requestId: string;
  service: string;
  status: ServiceResultStatus;
  attempts: number;
  items: unknown;
  exportUri: string | null;
  error: string | null;
  lastAttemptAt: Date | null;
  completedAt: Date | null;
}

export type DsrEventType =
  | 'received'
  | 'verified'
  | 'execution_started'
  | 'service_completed'
  | 'service_failed'
  | 'execution_partial'
  | 'export_created'
  | 'completed'
  | 'rejected';

export interface DsrEvent {
  id: string;
  requestId: string;
  at: Date;
  type: DsrEventType;
  actorId: string | null;
  details: Record<string, unknown> | null;
}

export interface DsrRepository {
  create(request: DsrRequest): Promise<void>;
  update(request: DsrRequest): Promise<void>;
  get(id: string): Promise<DsrRequest | undefined>;
  list(filter: { institutionId?: string; status?: DsrStatus }): Promise<DsrRequest[]>;
  findOpen(
    institutionId: string,
    subjectUserId: string,
    type: DsrType,
  ): Promise<DsrRequest | undefined>;
  upsertResult(result: DsrServiceResult): Promise<void>;
  listResults(requestId: string): Promise<DsrServiceResult[]>;
  addEvent(event: DsrEvent): Promise<void>;
  listEvents(requestId: string): Promise<DsrEvent[]>;
}

const clone = <T>(value: T): T => structuredClone(value);
const OPEN_STATUSES: readonly DsrStatus[] = ['received', 'verifying', 'in_progress'];

export class InMemoryDsrRepository implements DsrRepository {
  private readonly requests = new Map<string, DsrRequest>();
  private readonly results = new Map<string, DsrServiceResult>();
  private readonly events: DsrEvent[] = [];

  async create(request: DsrRequest): Promise<void> {
    this.requests.set(request.id, clone(request));
  }
  async update(request: DsrRequest): Promise<void> {
    this.requests.set(request.id, clone(request));
  }
  async get(id: string): Promise<DsrRequest | undefined> {
    const r = this.requests.get(id);
    return r ? clone(r) : undefined;
  }
  async list(filter: { institutionId?: string; status?: DsrStatus }): Promise<DsrRequest[]> {
    return [...this.requests.values()]
      .filter((r) => filter.institutionId === undefined || r.institutionId === filter.institutionId)
      .filter((r) => filter.status === undefined || r.status === filter.status)
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
      .map(clone);
  }
  async findOpen(
    institutionId: string,
    subjectUserId: string,
    type: DsrType,
  ): Promise<DsrRequest | undefined> {
    for (const r of this.requests.values()) {
      if (
        r.institutionId === institutionId &&
        r.subjectUserId === subjectUserId &&
        r.type === type &&
        OPEN_STATUSES.includes(r.status)
      ) {
        return clone(r);
      }
    }
    return undefined;
  }
  async upsertResult(result: DsrServiceResult): Promise<void> {
    this.results.set(`${result.requestId}:${result.service}`, clone(result));
  }
  async listResults(requestId: string): Promise<DsrServiceResult[]> {
    return [...this.results.values()]
      .filter((r) => r.requestId === requestId)
      .sort((a, b) => a.service.localeCompare(b.service))
      .map(clone);
  }
  async addEvent(event: DsrEvent): Promise<void> {
    this.events.push(clone(event));
  }
  async listEvents(requestId: string): Promise<DsrEvent[]> {
    return this.events.filter((e) => e.requestId === requestId).map(clone);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export interface DsrHandlerPayload {
  subjectType: SubjectType;
  subjectId: string;
  requestId: string;
  institutionId: string;
  details?: Record<string, unknown>;
}

export interface DsrHandlerResult {
  service: string;
  status: 'completed' | 'not_applicable' | 'failed';
  items: unknown;
  exportUri?: string;
  error?: string;
}

/** One per service holding personal data. Implementations must be idempotent (retries re-call them). */
export interface DataSubjectHandler {
  readonly name: string;
  handle(type: DsrType, payload: DsrHandlerPayload): Promise<DsrHandlerResult>;
}

const HandlerResponseSchema = z.object({
  service: z.string().min(1),
  status: z.enum(['completed', 'not_applicable', 'failed']),
  items: z.unknown(),
  exportUri: z.string().optional(),
  error: z.string().optional(),
});

/** POST {serviceUrl}/internal/v1/dsr/{type} { subjectType, subjectId, requestId, institutionId, details? } */
export class HttpDataSubjectHandler implements DataSubjectHandler {
  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly options: {
      fetch?: typeof fetch;
      internalToken?: string | undefined;
      timeoutMs?: number;
    } = {},
  ) {}

  async handle(type: DsrType, payload: DsrHandlerPayload): Promise<DsrHandlerResult> {
    const doFetch = this.options.fetch ?? globalThis.fetch;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.internalToken) headers['x-internal-token'] = this.options.internalToken;
    try {
      const response = await doFetch(new URL(`/internal/v1/dsr/${type}`, this.baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
      if (!response.ok) {
        return {
          service: this.name,
          status: 'failed',
          items: null,
          error: `HTTP ${response.status}`,
        };
      }
      const parsed = HandlerResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        return {
          service: this.name,
          status: 'failed',
          items: null,
          error: 'invalid handler response',
        };
      }
      const { exportUri, error, ...rest } = parsed.data;
      return {
        ...rest,
        items: rest.items ?? null,
        service: this.name,
        ...(exportUri !== undefined ? { exportUri } : {}),
        ...(error !== undefined ? { error } : {}),
      };
    } catch (err) {
      return {
        service: this.name,
        status: 'failed',
        items: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/** Parses DSR_HANDLER_URLS: "audit=http://audit:4011,notifications=http://notifications:4006". */
export function parseHandlerUrls(value: string | undefined): Array<{ name: string; url: string }> {
  if (!value || value.trim() === '') return [];
  return value
    .split(',')
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const index = pair.indexOf('=');
      const name = index > 0 ? pair.slice(0, index).trim() : '';
      const url = index > 0 ? pair.slice(index + 1).trim() : '';
      if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Invalid DSR handler name in "${pair}"`);
      if (!/^https?:\/\//.test(url)) throw new Error(`Invalid DSR handler URL in "${pair}"`);
      if (name === 'identity') throw new Error('"identity" is the built-in handler name');
      return { name, url };
    });
}

/** identity's own handler: credentials, sessions, login history and the profile itself. */
export class IdentityDataSubjectHandler implements DataSubjectHandler {
  readonly name = 'identity';

  constructor(
    private readonly repos: Repositories,
    private readonly now: () => Date,
  ) {}

  async handle(type: DsrType, payload: DsrHandlerPayload): Promise<DsrHandlerResult> {
    const user = await resolveSubjectUser(this.repos, payload);
    if (!user)
      return { service: this.name, status: 'not_applicable', items: { reason: 'no_account' } };
    const now = this.now();

    switch (type) {
      case 'access': {
        const logins = await this.repos.loginEvents.listByUser(user.id);
        const succeeded = logins.filter((l) => l.outcome === 'succeeded');
        const last = succeeded.reduce<Date | null>(
          (acc, l) => (acc === null || l.at > acc ? l.at : acc),
          null,
        );
        const credential = await this.repos.credentials.get(user.id);
        return {
          service: this.name,
          status: 'completed',
          items: {
            profile: {
              id: user.id,
              institutionId: user.institutionId,
              email: user.email,
              name: user.name,
              status: user.status,
              createdAt: user.createdAt.toISOString(),
            },
            roles: [user.role],
            links: { studentId: user.studentId, professorId: user.professorId },
            credentials: {
              hasPassword: credential !== undefined,
              passwordUpdatedAt: credential?.passwordUpdatedAt.toISOString() ?? null,
            },
            loginHistory: {
              total: logins.length,
              succeeded: succeeded.length,
              failed: logins.length - succeeded.length,
              lastSucceededAt: last?.toISOString() ?? null,
              byMethod: {
                password: logins.filter((l) => l.method === 'password').length,
                oidc: logins.filter((l) => l.method === 'oidc').length,
              },
            },
          },
        };
      }
      case 'deletion':
      case 'anonymization': {
        const credentialRemoved = await this.repos.credentials.delete(user.id);
        const refreshTokensRevoked = await this.repos.refreshTokens.revokeAllForUser(user.id, now);
        const loginEventsRemoved = await this.repos.loginEvents.deleteByUser(user.id);
        // The account row is kept as an anonymised, disabled tombstone so audit trails keep referential
        // integrity; it no longer identifies the person nor grants any access.
        await this.repos.users.update({
          ...user,
          email: `anon-${user.id}@anonymized.invalid`,
          name: 'Titular anonimizado',
          studentId: null,
          professorId: null,
          status: 'disabled',
          updatedAt: now,
        });
        return {
          service: this.name,
          status: 'completed',
          items: {
            credentialRemoved,
            refreshTokensRevoked,
            loginEventsRemoved,
            userDisabled: true,
            profileAnonymised: true,
          },
        };
      }
      case 'restriction': {
        const refreshTokensRevoked = await this.repos.refreshTokens.revokeAllForUser(user.id, now);
        await this.repos.users.update({ ...user, status: 'disabled', updatedAt: now });
        return {
          service: this.name,
          status: 'completed',
          items: { userDisabled: true, refreshTokensRevoked },
        };
      }
      case 'correction': {
        const corrections = CorrectionSchema.safeParse(payload.details ?? {});
        if (!corrections.success) {
          return {
            service: this.name,
            status: 'failed',
            items: null,
            error: 'invalid correction details',
          };
        }
        const fields: string[] = [];
        const updated: UserRecord = { ...user, updatedAt: now };
        if (corrections.data.name !== undefined) {
          updated.name = corrections.data.name;
          fields.push('name');
        }
        if (corrections.data.email !== undefined) {
          const clash = await this.repos.users.findByEmail(
            user.institutionId,
            corrections.data.email,
          );
          if (clash && clash.id !== user.id) {
            return {
              service: this.name,
              status: 'failed',
              items: null,
              error: 'email already in use',
            };
          }
          updated.email = corrections.data.email;
          fields.push('email');
        }
        if (fields.length === 0)
          return { service: this.name, status: 'not_applicable', items: { fields } };
        await this.repos.users.update(updated);
        return { service: this.name, status: 'completed', items: { fieldsCorrected: fields } };
      }
    }
  }
}

const CorrectionSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  email: z.string().trim().toLowerCase().email().max(255).optional(),
});

export async function resolveSubjectUser(
  repos: Repositories,
  subject: { institutionId: string; subjectType: SubjectType; subjectId: string },
): Promise<UserRecord | undefined> {
  if (subject.subjectType === 'user') {
    const user = await repos.users.findById(subject.subjectId);
    return user && user.institutionId === subject.institutionId ? user : undefined;
  }
  return repos.users.findByPersonId(subject.institutionId, subject.subjectType, subject.subjectId);
}

// ---------------------------------------------------------------------------
// Export store
// ---------------------------------------------------------------------------

export interface ExportStore {
  /** Stores an access-request bundle; returns its URI. */
  put(requestId: string, bundle: unknown): Promise<string>;
  get(uri: string): Promise<unknown>;
}

export class InMemoryExportStore implements ExportStore {
  readonly items = new Map<string, unknown>();
  async put(requestId: string, bundle: unknown): Promise<string> {
    const uri = `memory://dsr-exports/${requestId}.json`;
    this.items.set(uri, clone(bundle));
    return uri;
  }
  async get(uri: string): Promise<unknown> {
    return this.items.has(uri) ? clone(this.items.get(uri)) : undefined;
  }
}

/** Writes bundles to a local directory with mode 0600 (production: a CMEK bucket via the same interface). */
export class FileSystemExportStore implements ExportStore {
  constructor(private readonly directory: string) {}
  async put(requestId: string, bundle: unknown): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${requestId}.json`);
    await writeFile(path, JSON.stringify(bundle, null, 2), { mode: 0o600 });
    return pathToFileURL(path).toString();
  }
  async get(uri: string): Promise<unknown> {
    if (!uri.startsWith('file://')) return undefined;
    const path = fileURLToPath(uri);
    if (!path.startsWith(this.directory)) return undefined;
    try {
      return JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch {
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Workflow service
// ---------------------------------------------------------------------------

export class DsrError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface DsrDeps {
  repo: DsrRepository;
  /** Remote handlers; the identity handler is always added by the service. */
  handlers: DataSubjectHandler[];
  exportStore: ExportStore;
}

export interface DsrView {
  request: DsrRequest;
  overdue: boolean;
  daysRemaining: number;
}

export class DsrService {
  private readonly handlers: DataSubjectHandler[];
  private readonly executing = new Set<string>();

  constructor(
    private readonly deps: DsrDeps,
    repos: Repositories,
    private readonly now: () => Date,
  ) {
    this.handlers = [...deps.handlers, new IdentityDataSubjectHandler(repos, now)];
  }

  get handlerNames(): string[] {
    return this.handlers.map((h) => h.name);
  }

  view(request: DsrRequest): DsrView {
    const now = this.now().getTime();
    const open = OPEN_STATUSES.includes(request.status);
    return {
      request,
      overdue: open && now > request.dueAt.getTime(),
      daysRemaining: Math.ceil((request.dueAt.getTime() - now) / 86_400_000),
    };
  }

  private async event(
    requestId: string,
    type: DsrEventType,
    actorId: string | null,
    details: Record<string, unknown> | null = null,
  ): Promise<void> {
    await this.deps.repo.addEvent({
      id: randomUUID(),
      requestId,
      at: this.now(),
      type,
      actorId,
      details,
    });
  }

  async create(input: {
    institutionId: string;
    subjectType: SubjectType;
    subjectId: string;
    subjectUserId: string;
    type: DsrType;
    requestedBy: string;
    channel: DsrChannel;
    details: Record<string, unknown> | null;
  }): Promise<DsrRequest> {
    const open = await this.deps.repo.findOpen(
      input.institutionId,
      input.subjectUserId,
      input.type,
    );
    if (open)
      throw new DsrError(409, 'dsr_already_open', `An open ${input.type} request already exists`);
    const now = this.now();
    const request: DsrRequest = {
      id: randomUUID(),
      ...input,
      status: 'received',
      receivedAt: now,
      dueAt: new Date(now.getTime() + DSR_DUE_DAYS * 86_400_000),
      verifiedAt: null,
      verifiedBy: null,
      verificationMethod: null,
      completedAt: null,
      rejectedAt: null,
      rejectionReason: null,
      exportUri: null,
      executionAttempts: 0,
      updatedAt: now,
    };
    await this.deps.repo.create(request);
    await this.event(request.id, 'received', input.requestedBy, {
      channel: input.channel,
      type: input.type,
    });
    return request;
  }

  private async load(id: string): Promise<DsrRequest> {
    const request = await this.deps.repo.get(id);
    if (!request) throw new DsrError(404, 'not_found', 'DSR request not found');
    return request;
  }

  async verify(id: string, actorId: string, method: string, notes?: string): Promise<DsrRequest> {
    const request = await this.load(id);
    if (request.status !== 'received') {
      throw new DsrError(
        409,
        'invalid_transition',
        `Cannot verify a request in status ${request.status}`,
      );
    }
    const now = this.now();
    const updated: DsrRequest = {
      ...request,
      status: 'verifying',
      verifiedAt: now,
      verifiedBy: actorId,
      verificationMethod: method,
      updatedAt: now,
    };
    await this.deps.repo.update(updated);
    await this.event(id, 'verified', actorId, { method, ...(notes ? { notes } : {}) });
    return updated;
  }

  async reject(id: string, actorId: string, reason: string): Promise<DsrRequest> {
    const request = await this.load(id);
    if (request.status !== 'received' && request.status !== 'verifying') {
      throw new DsrError(
        409,
        'invalid_transition',
        `Cannot reject a request in status ${request.status}`,
      );
    }
    const now = this.now();
    const updated: DsrRequest = {
      ...request,
      status: 'rejected',
      rejectedAt: now,
      rejectionReason: reason,
      updatedAt: now,
    };
    await this.deps.repo.update(updated);
    await this.event(id, 'rejected', actorId, { reason });
    return updated;
  }

  /**
   * Fans out to every handler that has not yet succeeded. Returns the updated request; it is
   * `completed` only when every handler completed (or was not applicable).
   */
  async execute(
    id: string,
    actorId: string,
  ): Promise<{ request: DsrRequest; results: DsrServiceResult[]; ranServices: string[] }> {
    const request = await this.load(id);
    if (request.status !== 'verifying' && request.status !== 'in_progress') {
      throw new DsrError(
        409,
        'invalid_transition',
        `Cannot execute a request in status ${request.status}`,
      );
    }
    if (this.executing.has(id))
      throw new DsrError(409, 'execution_in_progress', 'Execution already running');
    this.executing.add(id);
    try {
      const existing = new Map((await this.deps.repo.listResults(id)).map((r) => [r.service, r]));
      const pending = this.handlers.filter((h) => {
        const status = existing.get(h.name)?.status;
        return status === undefined || status === 'pending' || status === 'failed';
      });

      let current: DsrRequest = {
        ...request,
        status: 'in_progress',
        executionAttempts: request.executionAttempts + 1,
        updatedAt: this.now(),
      };
      await this.deps.repo.update(current);
      await this.event(id, 'execution_started', actorId, {
        attempt: current.executionAttempts,
        services: pending.map((h) => h.name),
      });

      const payload: DsrHandlerPayload = {
        subjectType: request.subjectType,
        subjectId: request.subjectId,
        requestId: request.id,
        institutionId: request.institutionId,
        ...(request.details ? { details: request.details } : {}),
      };
      // Remote services first (in parallel), identity last: for deletions the subject's account is
      // only removed once every other service has processed the request.
      const remote = pending.filter((h) => h.name !== 'identity');
      const local = pending.filter((h) => h.name === 'identity');
      const run = async (handler: DataSubjectHandler): Promise<void> => {
        let result: DsrHandlerResult;
        try {
          result = await handler.handle(request.type, payload);
        } catch (err) {
          result = {
            service: handler.name,
            status: 'failed',
            items: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        const previous = existing.get(handler.name);
        const at = this.now();
        await this.deps.repo.upsertResult({
          requestId: id,
          service: handler.name,
          status: result.status,
          attempts: (previous?.attempts ?? 0) + 1,
          items: result.items ?? null,
          exportUri: result.exportUri ?? null,
          error: result.status === 'failed' ? (result.error ?? 'handler failed') : null,
          lastAttemptAt: at,
          completedAt: result.status === 'failed' ? null : at,
        });
        await this.event(
          id,
          result.status === 'failed' ? 'service_failed' : 'service_completed',
          actorId,
          {
            service: handler.name,
            status: result.status,
            ...(result.error ? { error: result.error } : {}),
          },
        );
      };
      await Promise.all(remote.map(run));
      const remoteFailed = (await this.deps.repo.listResults(id)).some(
        (r) => r.status === 'failed',
      );
      const destructive = request.type === 'deletion' || request.type === 'anonymization';
      if (!(destructive && remoteFailed)) {
        for (const handler of local) await run(handler);
      }

      const results = await this.deps.repo.listResults(id);
      const done = this.handlers.every((h) => {
        const status = results.find((r) => r.service === h.name)?.status;
        return status === 'completed' || status === 'not_applicable';
      });

      if (!done) {
        const failed = results.filter((r) => r.status === 'failed').map((r) => r.service);
        const deferred = this.handlers
          .filter((h) => !results.some((r) => r.service === h.name))
          .map((h) => h.name);
        await this.event(id, 'execution_partial', actorId, { failed, deferred });
        return { request: current, results, ranServices: pending.map((h) => h.name) };
      }

      const now = this.now();
      if (request.type === 'access') {
        const bundle = {
          format: 'ci-dsr-access-export/v1',
          requestId: request.id,
          institutionId: request.institutionId,
          subject: { type: request.subjectType, id: request.subjectId },
          generatedAt: now.toISOString(),
          services: results.map((r) => ({
            service: r.service,
            status: r.status,
            data: r.items,
            ...(r.exportUri ? { exportUri: r.exportUri } : {}),
          })),
        };
        const exportUri = await this.deps.exportStore.put(request.id, bundle);
        current = { ...current, exportUri };
        await this.event(id, 'export_created', actorId, { exportUri });
      }
      current = { ...current, status: 'completed', completedAt: now, updatedAt: now };
      await this.deps.repo.update(current);
      await this.event(id, 'completed', actorId, { attempts: current.executionAttempts });
      return { request: current, results, ranServices: pending.map((h) => h.name) };
    } finally {
      this.executing.delete(id);
    }
  }
}
