/**
 * PostgreSQL implementation of `OrganizationRepository` (integration stage §1).
 * Tables: holding_companies, institutions, campuses, classrooms, recording_policies,
 * recording_policy_versions, recording_consents, legal_holds, retention_jobs (V001–V004).
 */
import pg from 'pg';
import type {
  Campus,
  Classroom,
  Consent,
  HoldingCompany,
  Institution,
  LegalHold,
  RecordingPolicy,
  RecordingPolicyVersion,
  RetentionJob,
} from './domain.js';
import type { OrganizationRepository, Scope, Table } from './repository.js';

type Row = Record<string, unknown>;
type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const isoOpt = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : iso(v);
const strOpt = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : String(v);
const numOpt = (v: unknown): number | undefined =>
  v === null || v === undefined ? undefined : Number(v);

function defined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

interface Mapper<T> {
  table: string;
  /** Domain field → column, for every field that can be used in a `Scope`. */
  scopeColumns: Partial<Record<keyof T & string, string>>;
  toRow(item: T): Row;
  fromRow(row: Row): T;
  /** Append-only tables never update existing rows. */
  appendOnly?: boolean;
  orderBy?: string;
}

class PgTable<T extends { id: string }> implements Table<T> {
  constructor(
    private readonly pool: pg.Pool,
    readonly mapper: Mapper<T>,
  ) {}

  async get(id: string): Promise<T | undefined> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM ${this.mapper.table} WHERE id = $1`,
      [id],
    );
    return rows[0] ? this.mapper.fromRow(rows[0]) : undefined;
  }

  async list(filter?: (item: T) => boolean, scope?: Scope<T>): Promise<T[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const [field, value] of Object.entries(scope ?? {})) {
      if (value === undefined) continue;
      const column = this.mapper.scopeColumns[field as keyof T & string];
      if (!column) throw new Error(`${this.mapper.table}: no scope column for "${field}"`);
      params.push(value);
      clauses.push(`${column} = $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const order = this.mapper.orderBy ? `ORDER BY ${this.mapper.orderBy}` : '';
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM ${this.mapper.table} ${where} ${order}`,
      params,
    );
    const items = rows.map((r) => this.mapper.fromRow(r));
    return filter ? items.filter(filter) : items;
  }

  async save(item: T): Promise<T> {
    await saveRow(this.pool, this.mapper, item);
    return item;
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.pool.query(`DELETE FROM ${this.mapper.table} WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }
}

async function saveRow<T>(db: Queryable, mapper: Mapper<T>, item: T): Promise<void> {
  const row = mapper.toRow(item);
  const columns = Object.keys(row);
  const values = Object.values(row);
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  const updates = columns.filter((c) => c !== 'id').map((c) => `${c} = EXCLUDED.${c}`);
  const conflict = mapper.appendOnly ? 'DO NOTHING' : `DO UPDATE SET ${updates.join(', ')}`;
  await db.query(
    `INSERT INTO ${mapper.table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})
     ON CONFLICT (id) ${conflict}`,
    values,
  );
}

// ------------------------------------------------------------------ mappers
const holdingMapper: Mapper<HoldingCompany> = {
  table: 'holding_companies',
  scopeColumns: {},
  orderBy: 'name',
  toRow: (h) => ({
    id: h.id,
    name: h.name,
    legal_name: h.legalName,
    country: h.country,
    created_at: h.createdAt,
    updated_at: h.updatedAt,
  }),
  fromRow: (r) => ({
    id: String(r['id']),
    name: String(r['name']),
    legalName: String(r['legal_name']),
    country: String(r['country']),
    createdAt: iso(r['created_at']),
    updatedAt: iso(r['updated_at']),
  }),
};

const institutionMapper: Mapper<Institution> = {
  table: 'institutions',
  scopeColumns: { holdingCompanyId: 'holding_company_id' },
  orderBy: 'name',
  toRow: (i) => ({
    id: i.id,
    holding_company_id: i.holdingCompanyId,
    name: i.name,
    brand: i.brand ?? null,
    country: i.country,
    state: i.state,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
  }),
  fromRow: (r) =>
    defined({
      id: String(r['id']),
      holdingCompanyId: String(r['holding_company_id']),
      name: String(r['name']),
      brand: strOpt(r['brand']),
      country: String(r['country']),
      state: String(r['state']),
      createdAt: iso(r['created_at']),
      updatedAt: iso(r['updated_at']),
    }) as Institution,
};

const campusMapper: Mapper<Campus> = {
  table: 'campuses',
  scopeColumns: { institutionId: 'institution_id' },
  orderBy: 'name',
  toRow: (c) => ({
    id: c.id,
    institution_id: c.institutionId,
    name: c.name,
    city: c.city,
    state: c.state,
    timezone: c.timezone,
    recording_policy_id: c.recordingPolicyId ?? null,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  }),
  fromRow: (r) =>
    defined({
      id: String(r['id']),
      institutionId: String(r['institution_id']),
      name: String(r['name']),
      city: String(r['city']),
      state: String(r['state']),
      timezone: String(r['timezone']),
      recordingPolicyId: strOpt(r['recording_policy_id']),
      createdAt: iso(r['created_at']),
      updatedAt: iso(r['updated_at']),
    }) as Campus,
};

const classroomMapper: Mapper<Classroom> = {
  table: 'classrooms',
  scopeColumns: { campusId: 'campus_id' },
  orderBy: 'code',
  toRow: (c) => ({
    id: c.id,
    campus_id: c.campusId,
    name: c.name,
    code: c.code,
    capacity: c.capacity ?? null,
    recording_policy_id: c.recordingPolicyId ?? null,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  }),
  fromRow: (r) =>
    defined({
      id: String(r['id']),
      campusId: String(r['campus_id']),
      name: String(r['name']),
      code: String(r['code']),
      capacity: numOpt(r['capacity']),
      recordingPolicyId: strOpt(r['recording_policy_id']),
      createdAt: iso(r['created_at']),
      updatedAt: iso(r['updated_at']),
    }) as Classroom,
};

const policyMapper: Mapper<RecordingPolicy> = {
  table: 'recording_policies',
  scopeColumns: { institutionId: 'institution_id' },
  orderBy: 'created_at, name',
  toRow: (p) => ({
    id: p.id,
    institution_id: p.institutionId,
    name: p.name,
    description: p.description ?? null,
    legal_basis: p.legalBasis,
    requires_explicit_consent: p.requiresExplicitConsent,
    audio_retention_days: p.audioRetentionDays,
    transcript_retention_days: p.transcriptRetentionDays,
    summary_retention_days: p.summaryRetentionDays,
    extracted_event_retention_days: p.extractedEventRetentionDays,
    allow_raw_audio_access: p.allowRawAudioAccess,
    pre_roll_minutes: p.preRollMinutes,
    post_roll_minutes: p.postRollMinutes,
    recording_enabled: p.recordingEnabled,
    is_default: p.isDefault,
    current_version: p.currentVersion,
    current_version_id: p.currentVersionId,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  }),
  fromRow: (r) =>
    defined({
      id: String(r['id']),
      institutionId: String(r['institution_id']),
      name: String(r['name']),
      description: strOpt(r['description']),
      legalBasis: String(r['legal_basis']),
      requiresExplicitConsent: Boolean(r['requires_explicit_consent']),
      audioRetentionDays: Number(r['audio_retention_days']),
      transcriptRetentionDays: Number(r['transcript_retention_days']),
      summaryRetentionDays: Number(r['summary_retention_days']),
      extractedEventRetentionDays: Number(r['extracted_event_retention_days']),
      allowRawAudioAccess: Boolean(r['allow_raw_audio_access']),
      preRollMinutes: Number(r['pre_roll_minutes']),
      postRollMinutes: Number(r['post_roll_minutes']),
      recordingEnabled: Boolean(r['recording_enabled']),
      isDefault: Boolean(r['is_default']),
      currentVersion: Number(r['current_version']),
      currentVersionId: String(r['current_version_id'] ?? ''),
      createdAt: iso(r['created_at']),
      updatedAt: iso(r['updated_at']),
    }) as RecordingPolicy,
};

const versionMapper: Mapper<RecordingPolicyVersion> = {
  table: 'recording_policy_versions',
  scopeColumns: { policyId: 'policy_id', institutionId: 'institution_id' },
  appendOnly: true,
  orderBy: 'version',
  toRow: (v) => ({
    id: v.id,
    policy_id: v.policyId,
    institution_id: v.institutionId,
    version: v.version,
    content: JSON.stringify(v.content),
    changed_fields: v.changedFields,
    change_reason: v.changeReason ?? null,
    created_by: v.createdBy,
    created_at: v.createdAt,
  }),
  fromRow: (r) =>
    defined({
      id: String(r['id']),
      policyId: String(r['policy_id']),
      institutionId: String(r['institution_id']),
      version: Number(r['version']),
      content: r['content'] as RecordingPolicyVersion['content'],
      changedFields: (r['changed_fields'] ?? []) as RecordingPolicyVersion['changedFields'],
      changeReason: strOpt(r['change_reason']),
      createdBy: (r['created_by'] as string | null) ?? null,
      createdAt: iso(r['created_at']),
    }) as RecordingPolicyVersion,
};

const consentMapper: Mapper<Consent> = {
  table: 'recording_consents',
  scopeColumns: {
    policyId: 'recording_policy_id',
    subjectId: 'subject_id',
    classSectionId: 'class_section_id',
    institutionId: 'institution_id',
  },
  orderBy: 'recorded_at, created_at',
  toRow: (c) => ({
    id: c.id,
    institution_id: c.institutionId,
    subject_type: c.subjectType,
    subject_id: c.subjectId,
    recording_policy_id: c.policyId,
    policy_version: c.policyVersion,
    class_section_id: c.classSectionId ?? null,
    consent_given: c.given,
    consented_at: c.given ? c.recordedAt : null,
    actor_id: c.actorId,
    recorded_at: c.recordedAt,
    withdrawn_at: c.withdrawnAt ?? null,
    withdrawn_by: c.withdrawnBy ?? null,
    withdrawal_reason: c.withdrawalReason ?? null,
    superseded_at: c.supersededAt ?? null,
    superseded_by: c.supersededBy ?? null,
  }),
  fromRow: (r) =>
    defined({
      id: String(r['id']),
      institutionId: String(r['institution_id']),
      subjectType: r['subject_type'] as Consent['subjectType'],
      subjectId: String(r['subject_id']),
      policyId: String(r['recording_policy_id']),
      policyVersion: Number(r['policy_version'] ?? 1),
      classSectionId: strOpt(r['class_section_id']),
      given: Boolean(r['consent_given']),
      actorId: String(r['actor_id']),
      recordedAt: iso(r['recorded_at']),
      withdrawnAt: isoOpt(r['withdrawn_at']),
      withdrawnBy: strOpt(r['withdrawn_by']),
      withdrawalReason: strOpt(r['withdrawal_reason']),
      supersededAt: isoOpt(r['superseded_at']),
      supersededBy: strOpt(r['superseded_by']),
    }) as Consent,
};

const holdMapper: Mapper<LegalHold> = {
  table: 'legal_holds',
  scopeColumns: { institutionId: 'institution_id' },
  orderBy: 'created_at',
  toRow: (h) => ({
    id: h.id,
    institution_id: h.institutionId,
    scope_type: h.scope.type,
    scope_id: h.scope.id,
    reason: h.reason,
    created_by: h.createdBy,
    created_at: h.createdAt,
    released_at: h.releasedAt ?? null,
    released_by: h.releasedBy ?? null,
    release_reason: h.releaseReason ?? null,
  }),
  fromRow: (r) =>
    defined({
      id: String(r['id']),
      institutionId: String(r['institution_id']),
      scope: { type: r['scope_type'] as LegalHold['scope']['type'], id: String(r['scope_id']) },
      reason: String(r['reason']),
      createdBy: String(r['created_by'] ?? ''),
      createdAt: iso(r['created_at']),
      releasedAt: isoOpt(r['released_at']),
      releasedBy: strOpt(r['released_by']),
      releaseReason: strOpt(r['release_reason']),
    }) as LegalHold,
};

const jobMapper: Mapper<RetentionJob> = {
  table: 'retention_jobs',
  scopeColumns: { institutionId: 'institution_id' },
  orderBy: 'started_at',
  toRow: (j) => ({
    id: j.id,
    institution_id: j.institutionId,
    dry_run: j.dryRun,
    reference_time: j.referenceTime,
    requested_by: j.requestedBy,
    status: j.status,
    started_at: j.startedAt,
    finished_at: j.finishedAt ?? null,
    kinds: JSON.stringify(j.kinds),
    holds_applied: j.holdsApplied,
    unconfigured_kinds: j.unconfiguredKinds,
    errors: JSON.stringify(j.errors),
  }),
  fromRow: (r) =>
    defined({
      id: String(r['id']),
      institutionId: String(r['institution_id']),
      dryRun: Boolean(r['dry_run']),
      referenceTime: iso(r['reference_time']),
      requestedBy: (r['requested_by'] as string | null) ?? null,
      status: r['status'] as RetentionJob['status'],
      startedAt: iso(r['started_at']),
      finishedAt: isoOpt(r['finished_at']),
      kinds: r['kinds'] as RetentionJob['kinds'],
      holdsApplied: (r['holds_applied'] ?? []) as string[],
      unconfiguredKinds: (r['unconfigured_kinds'] ?? []) as RetentionJob['unconfiguredKinds'],
      errors: (r['errors'] ?? []) as RetentionJob['errors'],
    }) as RetentionJob,
};

// ------------------------------------------------------------------ repository
export function createPgOrganizationRepository(pool: pg.Pool): OrganizationRepository {
  const tx = async <R>(fn: (client: pg.PoolClient) => Promise<R>): Promise<R> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };

  return {
    holdingCompanies: new PgTable(pool, holdingMapper),
    institutions: new PgTable(pool, institutionMapper),
    campuses: new PgTable(pool, campusMapper),
    classrooms: new PgTable(pool, classroomMapper),
    recordingPolicies: new PgTable(pool, policyMapper),
    recordingPolicyVersions: new PgTable(pool, versionMapper),
    consents: new PgTable(pool, consentMapper),
    legalHolds: new PgTable(pool, holdMapper),
    retentionJobs: new PgTable(pool, jobMapper),

    commitPolicy: ({ policy, version }) =>
      tx(async (client) => {
        // Serialise policy changes per institution (default switch + version numbering).
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [policy.institutionId]);
        if (policy.isDefault) {
          await client.query(
            `UPDATE recording_policies SET is_default = FALSE, updated_at = $3
              WHERE institution_id = $1 AND id <> $2 AND is_default`,
            [policy.institutionId, policy.id, policy.updatedAt],
          );
        }
        // current_version_id → recording_policy_versions is DEFERRABLE: the policy row may point
        // at the version inserted right after it, within this transaction.
        await saveRow(client, policyMapper, policy);
        if (version) await saveRow(client, versionMapper, version);
      }),

    recordConsent: (consent, previous) =>
      tx(async (client) => {
        const ids = previous.map((p) => p.id);
        if (ids.length > 0) {
          // Supersede first: uq_recording_consents_current allows one current row per scope.
          await client.query(
            `UPDATE recording_consents SET superseded_at = $2 WHERE id = ANY($1::uuid[])`,
            [ids, consent.recordedAt],
          );
        }
        await saveRow(client, consentMapper, consent);
        if (ids.length > 0) {
          await client.query(
            `UPDATE recording_consents SET superseded_by = $2 WHERE id = ANY($1::uuid[])`,
            [ids, consent.id],
          );
        }
      }),

    async startRetentionJob(job): Promise<boolean> {
      const row = jobMapper.toRow(job);
      const columns = Object.keys(row);
      const res = await pool.query(
        `INSERT INTO retention_jobs (${columns.join(', ')})
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT (institution_id) WHERE status = 'running' DO NOTHING
         RETURNING id`,
        Object.values(row),
      );
      return (res.rowCount ?? 0) > 0;
    },
  };
}

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max });
}
