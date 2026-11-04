/** Persistence for connector configs, sync history and LMS publications. */
import type { ImportIssue, ImportReport } from '../domain.js';
import type { ConnectorConfig, ConnectorType, PullStats } from './types.js';

export type SyncRunStatus = 'running' | 'succeeded' | 'partial' | 'rejected' | 'failed';

export interface SyncRun {
  id: string;
  institutionId: string;
  type: ConnectorType;
  status: SyncRunStatus;
  dryRun: boolean;
  since: string | null;
  triggeredBy: string | null;
  importId: string | null;
  importStatus: ImportReport['status'] | null;
  counts: ImportReport['counts'] | null;
  warnings: ImportIssue[];
  errors: ImportIssue[];
  error: { code: string; message: string } | null;
  stats: PullStats | null;
  startedAt: string;
  finishedAt: string | null;
}

export type PublicationKind = 'announcement' | 'calendar_item';
export type PublicationSource = 'calendar_event' | 'lecture_summary';

export interface Publication {
  id: string;
  institutionId: string;
  type: ConnectorType;
  sourceType: PublicationSource;
  sourceId: string;
  kind: PublicationKind;
  classSectionId: string;
  lmsCourseId: string;
  status: 'published' | 'failed';
  externalId: string | null;
  attempts: number;
  lastError: string | null;
  sourceEventId: string;
  createdAt: string;
  updatedAt: string;
}

export const publicationKey = (
  p: Pick<Publication, 'institutionId' | 'type' | 'sourceType' | 'sourceId' | 'kind'>,
): string => `${p.institutionId}|${p.type}|${p.sourceType}|${p.sourceId}|${p.kind}`;

/** A `running` run older than this is considered abandoned (crashed instance) and no longer blocks. */
export const STALE_RUN_MS = 2 * 3_600_000;

export interface ConnectorStore {
  getConfig(institutionId: string, type: ConnectorType): Promise<ConnectorConfig | null>;
  listConfigs(institutionId: string): Promise<ConnectorConfig[]>;
  /** Upsert; returns true when created. */
  saveConfig(config: ConnectorConfig): Promise<boolean>;
  setLastSuccessfulSync(institutionId: string, type: ConnectorType, at: string): Promise<void>;
  /** Inserts a `running` run unless one is already running (then false). Abandoned runs are failed first. */
  startRun(run: SyncRun, now: Date): Promise<boolean>;
  finishRun(run: SyncRun): Promise<void>;
  listRuns(institutionId: string, type: ConnectorType, limit: number): Promise<SyncRun[]>;
  getRun(id: string): Promise<SyncRun | null>;
  getPublication(key: Pick<Publication, 'institutionId' | 'type' | 'sourceType' | 'sourceId' | 'kind'>): Promise<Publication | null>;
  savePublication(p: Publication): Promise<void>;
  listPublications(institutionId: string, type: ConnectorType, limit: number): Promise<Publication[]>;
}

export class InMemoryConnectorStore implements ConnectorStore {
  private readonly configs = new Map<string, ConnectorConfig>();
  private readonly runs = new Map<string, SyncRun>();
  private readonly publications = new Map<string, Publication>();

  getConfig(institutionId: string, type: ConnectorType): Promise<ConnectorConfig | null> {
    const c = this.configs.get(`${institutionId}|${type}`);
    return Promise.resolve(c ? structuredClone(c) : null);
  }

  listConfigs(institutionId: string): Promise<ConnectorConfig[]> {
    return Promise.resolve(
      [...this.configs.values()]
        .filter((c) => c.institutionId === institutionId)
        .sort((a, b) => a.type.localeCompare(b.type))
        .map((c) => structuredClone(c)),
    );
  }

  saveConfig(config: ConnectorConfig): Promise<boolean> {
    const key = `${config.institutionId}|${config.type}`;
    const created = !this.configs.has(key);
    this.configs.set(key, structuredClone(config));
    return Promise.resolve(created);
  }

  setLastSuccessfulSync(institutionId: string, type: ConnectorType, at: string): Promise<void> {
    const c = this.configs.get(`${institutionId}|${type}`);
    if (c) c.lastSuccessfulSyncAt = at;
    return Promise.resolve();
  }

  startRun(run: SyncRun, now: Date): Promise<boolean> {
    for (const r of this.runs.values()) {
      if (r.institutionId !== run.institutionId || r.type !== run.type || r.status !== 'running') continue;
      if (now.getTime() - Date.parse(r.startedAt) < STALE_RUN_MS) return Promise.resolve(false);
      r.status = 'failed';
      r.error = { code: 'abandoned', message: 'run did not finish' };
      r.finishedAt = now.toISOString();
    }
    this.runs.set(run.id, structuredClone(run));
    return Promise.resolve(true);
  }

  finishRun(run: SyncRun): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
    return Promise.resolve();
  }

  listRuns(institutionId: string, type: ConnectorType, limit: number): Promise<SyncRun[]> {
    return Promise.resolve(
      [...this.runs.values()]
        .filter((r) => r.institutionId === institutionId && r.type === type)
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
        .slice(0, limit)
        .map((r) => structuredClone(r)),
    );
  }

  getRun(id: string): Promise<SyncRun | null> {
    const r = this.runs.get(id);
    return Promise.resolve(r ? structuredClone(r) : null);
  }

  getPublication(key: Pick<Publication, 'institutionId' | 'type' | 'sourceType' | 'sourceId' | 'kind'>): Promise<Publication | null> {
    const p = this.publications.get(publicationKey(key));
    return Promise.resolve(p ? structuredClone(p) : null);
  }

  savePublication(p: Publication): Promise<void> {
    this.publications.set(publicationKey(p), structuredClone(p));
    return Promise.resolve();
  }

  listPublications(institutionId: string, type: ConnectorType, limit: number): Promise<Publication[]> {
    return Promise.resolve(
      [...this.publications.values()]
        .filter((p) => p.institutionId === institutionId && p.type === type)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit)
        .map((p) => structuredClone(p)),
    );
  }
}
