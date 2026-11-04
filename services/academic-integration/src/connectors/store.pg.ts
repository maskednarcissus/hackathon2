/** Postgres implementation of the connector store (pending migration academic-integration-phase6.sql). */
import type { ImportIssue } from '../domain.js';
import { MissingReferenceError } from '../repository.js';
import { iso, isoOrNull, PG, pgCode, withTransaction, type Pool } from '../platform/pg.js';
import {
  STALE_RUN_MS,
  type ConnectorStore,
  type Publication,
  type SyncRun,
} from './store.js';
import type { ConnectorConfig, ConnectorType } from './types.js';

type Row = Record<string, unknown>;

const config = (r: Row): ConnectorConfig =>
  ({
    institutionId: String(r['institution_id']),
    type: r['connector_type'] as ConnectorType,
    baseUrl: String(r['base_url']),
    enabled: Boolean(r['enabled']),
    auth: r['auth'] as ConnectorConfig['auth'],
    mappings: r['mappings'] as ConnectorConfig['mappings'],
    outbound: r['outbound'] as ConnectorConfig['outbound'],
    lastSuccessfulSyncAt: isoOrNull(r['last_successful_sync_at']),
    createdAt: iso(r['created_at']),
    updatedAt: iso(r['updated_at']),
  }) satisfies ConnectorConfig;

const run = (r: Row): SyncRun => ({
  id: String(r['id']),
  institutionId: String(r['institution_id']),
  type: r['connector_type'] as ConnectorType,
  status: r['status'] as SyncRun['status'],
  dryRun: Boolean(r['dry_run']),
  since: isoOrNull(r['since']),
  triggeredBy: (r['triggered_by'] as string | null) ?? null,
  importId: (r['import_id'] as string | null) ?? null,
  importStatus: (r['import_status'] as SyncRun['importStatus']) ?? null,
  counts: (r['counts'] as SyncRun['counts']) ?? null,
  warnings: (r['warnings'] as ImportIssue[] | null) ?? [],
  errors: (r['errors'] as ImportIssue[] | null) ?? [],
  error: (r['error'] as SyncRun['error']) ?? null,
  stats: (r['stats'] as SyncRun['stats']) ?? null,
  startedAt: iso(r['started_at']),
  finishedAt: isoOrNull(r['finished_at']),
});

const publication = (r: Row): Publication => ({
  id: String(r['id']),
  institutionId: String(r['institution_id']),
  type: r['connector_type'] as ConnectorType,
  sourceType: r['source_type'] as Publication['sourceType'],
  sourceId: String(r['source_id']),
  kind: r['kind'] as Publication['kind'],
  classSectionId: String(r['class_section_id']),
  lmsCourseId: String(r['lms_course_id']),
  status: r['status'] as Publication['status'],
  externalId: (r['external_id'] as string | null) ?? null,
  attempts: Number(r['attempts']),
  lastError: (r['last_error'] as string | null) ?? null,
  sourceEventId: String(r['source_event_id']),
  createdAt: iso(r['created_at']),
  updatedAt: iso(r['updated_at']),
});

export class PgConnectorStore implements ConnectorStore {
  constructor(private readonly pool: Pool) {}

  async getConfig(institutionId: string, type: ConnectorType): Promise<ConnectorConfig | null> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM academic_connectors WHERE institution_id = $1 AND connector_type = $2',
      [institutionId, type],
    );
    return rows[0] ? config(rows[0]) : null;
  }

  async listConfigs(institutionId: string): Promise<ConnectorConfig[]> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM academic_connectors WHERE institution_id = $1 ORDER BY connector_type',
      [institutionId],
    );
    return rows.map(config);
  }

  async saveConfig(c: ConnectorConfig): Promise<boolean> {
    try {
      const { rows } = await this.pool.query<{ created: boolean }>(
        `INSERT INTO academic_connectors (institution_id, connector_type, base_url, enabled, auth, mappings, outbound,
                                          last_successful_sync_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (institution_id, connector_type) DO UPDATE SET
           base_url = EXCLUDED.base_url, enabled = EXCLUDED.enabled, auth = EXCLUDED.auth,
           mappings = EXCLUDED.mappings, outbound = EXCLUDED.outbound, updated_at = EXCLUDED.updated_at
         RETURNING (xmax = 0) AS created`,
        [
          c.institutionId,
          c.type,
          c.baseUrl,
          c.enabled,
          JSON.stringify(c.auth),
          JSON.stringify(c.mappings),
          JSON.stringify(c.outbound),
          c.lastSuccessfulSyncAt,
          c.createdAt,
          c.updatedAt,
        ],
      );
      return rows[0]?.created === true;
    } catch (err) {
      if (pgCode(err) === PG.foreignKeyViolation) throw new MissingReferenceError('academic_connectors_institution_id_fkey');
      throw err;
    }
  }

  async setLastSuccessfulSync(institutionId: string, type: ConnectorType, at: string): Promise<void> {
    await this.pool.query(
      `UPDATE academic_connectors SET last_successful_sync_at = GREATEST(COALESCE(last_successful_sync_at, $3), $3)
       WHERE institution_id = $1 AND connector_type = $2`,
      [institutionId, type, at],
    );
  }

  startRun(r: SyncRun, now: Date): Promise<boolean> {
    return withTransaction(this.pool, async (c) => {
      await c.query(
        `UPDATE academic_connector_runs
         SET status = 'failed', error = '{"code":"abandoned","message":"run did not finish"}'::jsonb, finished_at = $3
         WHERE institution_id = $1 AND connector_type = $2 AND status = 'running' AND started_at < $4`,
        [r.institutionId, r.type, now.toISOString(), new Date(now.getTime() - STALE_RUN_MS).toISOString()],
      );
      try {
        await c.query('SAVEPOINT start_run');
        await c.query(
          `INSERT INTO academic_connector_runs (id, institution_id, connector_type, status, dry_run, since, triggered_by, started_at)
           VALUES ($1, $2, $3, 'running', $4, $5, $6, $7)`,
          [r.id, r.institutionId, r.type, r.dryRun, r.since, r.triggeredBy, r.startedAt],
        );
        return true;
      } catch (err) {
        if (pgCode(err) !== PG.uniqueViolation) throw err;
        await c.query('ROLLBACK TO SAVEPOINT start_run');
        return false;
      }
    });
  }

  async finishRun(r: SyncRun): Promise<void> {
    await this.pool.query(
      `UPDATE academic_connector_runs SET status = $2, import_id = $3, import_status = $4, counts = $5,
         warnings = $6, errors = $7, error = $8, stats = $9, finished_at = $10
       WHERE id = $1`,
      [
        r.id,
        r.status,
        r.importId,
        r.importStatus,
        r.counts ? JSON.stringify(r.counts) : null,
        JSON.stringify(r.warnings),
        JSON.stringify(r.errors),
        r.error ? JSON.stringify(r.error) : null,
        r.stats ? JSON.stringify(r.stats) : null,
        r.finishedAt,
      ],
    );
  }

  async listRuns(institutionId: string, type: ConnectorType, limit: number): Promise<SyncRun[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM academic_connector_runs WHERE institution_id = $1 AND connector_type = $2
       ORDER BY started_at DESC LIMIT $3`,
      [institutionId, type, limit],
    );
    return rows.map(run);
  }

  async getRun(id: string): Promise<SyncRun | null> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM academic_connector_runs WHERE id = $1', [id]);
    return rows[0] ? run(rows[0]) : null;
  }

  async getPublication(
    key: Pick<Publication, 'institutionId' | 'type' | 'sourceType' | 'sourceId' | 'kind'>,
  ): Promise<Publication | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM lms_publications WHERE institution_id = $1 AND connector_type = $2
         AND source_type = $3 AND source_id = $4 AND kind = $5`,
      [key.institutionId, key.type, key.sourceType, key.sourceId, key.kind],
    );
    return rows[0] ? publication(rows[0]) : null;
  }

  async savePublication(p: Publication): Promise<void> {
    await this.pool.query(
      `INSERT INTO lms_publications (id, institution_id, connector_type, source_type, source_id, kind,
         class_section_id, lms_course_id, status, external_id, attempts, last_error, source_event_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (institution_id, connector_type, source_type, source_id, kind) DO UPDATE SET
         lms_course_id = EXCLUDED.lms_course_id,
         -- never downgrade a published item (a concurrent delivery may have published it)
         status = CASE WHEN lms_publications.status = 'published' THEN 'published' ELSE EXCLUDED.status END,
         external_id = COALESCE(lms_publications.external_id, EXCLUDED.external_id),
         attempts = GREATEST(lms_publications.attempts, EXCLUDED.attempts),
         last_error = EXCLUDED.last_error, updated_at = EXCLUDED.updated_at`,
      [
        p.id,
        p.institutionId,
        p.type,
        p.sourceType,
        p.sourceId,
        p.kind,
        p.classSectionId,
        p.lmsCourseId,
        p.status,
        p.externalId,
        p.attempts,
        p.lastError,
        p.sourceEventId,
        p.createdAt,
        p.updatedAt,
      ],
    );
  }

  async listPublications(institutionId: string, type: ConnectorType, limit: number): Promise<Publication[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM lms_publications WHERE institution_id = $1 AND connector_type = $2
       ORDER BY created_at DESC LIMIT $3`,
      [institutionId, type, limit],
    );
    return rows.map(publication);
  }
}
