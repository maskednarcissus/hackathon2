import type pg from 'pg';
import type {
  CampusDaily,
  CostAllocation,
  CostDaily,
  InstitutionDaily,
  PipelineRun,
} from './domain.js';

export interface FactQuery {
  institutionIds: readonly string[];
  from: string;
  to: string;
}

/**
 * Analytical store for the group fact tables. Writes are idempotent per (institution, date):
 * a pipeline re-run for a date replaces that date's rows.
 */
export interface Warehouse {
  replaceDay(
    date: string,
    institutionIds: readonly string[],
    rows: {
      institutions: InstitutionDaily[];
      campuses: CampusDaily[];
      costs: CostDaily[];
    },
  ): Promise<void>;
  institutionDaily(q: FactQuery): Promise<InstitutionDaily[]>;
  campusDaily(q: FactQuery): Promise<CampusDaily[]>;
  costDaily(q: FactQuery): Promise<CostDaily[]>;
  /** Latest date with institution facts for any of the institutions, or null. */
  dataThrough(institutionIds: readonly string[]): Promise<string | null>;
  saveRun(run: PipelineRun): Promise<void>;
  listRuns(limit: number): Promise<PipelineRun[]>;
  addAllocation(a: CostAllocation): Promise<void>;
  allocations(institutionIds: readonly string[], month: string): Promise<CostAllocation[]>;
  listAllocations(holdingCompanyId: string): Promise<CostAllocation[]>;
}

const inRange = (q: FactQuery) => (r: { institutionId: string; date: string }) =>
  q.institutionIds.includes(r.institutionId) && r.date >= q.from && r.date <= q.to;

export class InMemoryWarehouse implements Warehouse {
  private institutions: InstitutionDaily[] = [];
  private campuses: CampusDaily[] = [];
  private costs: CostDaily[] = [];
  private runs: PipelineRun[] = [];
  private allocationRows: CostAllocation[] = [];

  async replaceDay(
    date: string,
    institutionIds: readonly string[],
    rows: { institutions: InstitutionDaily[]; campuses: CampusDaily[]; costs: CostDaily[] },
  ): Promise<void> {
    const keep = <T extends { institutionId: string; date: string }>(r: T): boolean =>
      !(r.date === date && institutionIds.includes(r.institutionId));
    this.institutions = [...this.institutions.filter(keep), ...rows.institutions];
    this.campuses = [...this.campuses.filter(keep), ...rows.campuses];
    this.costs = [...this.costs.filter(keep), ...rows.costs];
  }

  async institutionDaily(q: FactQuery): Promise<InstitutionDaily[]> {
    return this.institutions.filter(inRange(q)).map((r) => ({ ...r }));
  }

  async campusDaily(q: FactQuery): Promise<CampusDaily[]> {
    return this.campuses.filter(inRange(q)).map((r) => ({ ...r }));
  }

  async costDaily(q: FactQuery): Promise<CostDaily[]> {
    return this.costs.filter(inRange(q)).map((r) => ({ ...r }));
  }

  async dataThrough(institutionIds: readonly string[]): Promise<string | null> {
    const dates = this.institutions
      .filter((r) => institutionIds.includes(r.institutionId))
      .map((r) => r.date)
      .sort();
    return dates.at(-1) ?? null;
  }

  async saveRun(run: PipelineRun): Promise<void> {
    this.runs.push(run);
  }

  async listRuns(limit: number): Promise<PipelineRun[]> {
    return [...this.runs].reverse().slice(0, limit);
  }

  async addAllocation(a: CostAllocation): Promise<void> {
    this.allocationRows.push(a);
  }

  async allocations(institutionIds: readonly string[], month: string): Promise<CostAllocation[]> {
    return this.allocationRows.filter(
      (a) => institutionIds.includes(a.institutionId) && a.month === month,
    );
  }

  async listAllocations(holdingCompanyId: string): Promise<CostAllocation[]> {
    return this.allocationRows.filter((a) => a.holdingCompanyId === holdingCompanyId);
  }
}

// ---------------------------------------------------------------- PostgreSQL

const INSTITUTION_COLUMNS: (keyof InstitutionDaily)[] = [
  'holdingCompanyId',
  'institutionId',
  'date',
  'classesScheduled',
  'classesCaptured',
  'classesTranscribed',
  'classesStructured',
  'eventsExtracted',
  'eventsReviewed',
  'professorsTeaching',
  'activeProfessors',
  'activeStudents',
  'assistantQuestions',
  'searches',
  'devicesTotal',
  'devicesOnline',
  'deviceUptimePct',
  'firmwareCurrentPct',
  'incidentsOpened',
  'incidentsResolved',
  'mttrMinutes',
  'aiCostUsd',
  'sttCostUsd',
  'storageCostUsd',
  'infraCostUsd',
  'builtAt',
];
const CAMPUS_COLUMNS: (keyof CampusDaily)[] = [
  'holdingCompanyId',
  'institutionId',
  'campusId',
  'date',
  'classesScheduled',
  'classesCaptured',
  'devicesTotal',
  'devicesOnline',
  'sttCostUsd',
  'storageCostUsd',
  'hardwareCostUsd',
  'builtAt',
];
const COST_COLUMNS: (keyof CostDaily)[] = [
  'holdingCompanyId',
  'institutionId',
  'campusId',
  'date',
  'category',
  'amountUsd',
  'source',
];

export const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const NUMERIC_FIELDS = new Set<string>([
  ...INSTITUTION_COLUMNS.filter(
    (c) => !['holdingCompanyId', 'institutionId', 'date', 'builtAt'].includes(c),
  ),
  'devicesTotal',
  'amountUsd',
  'hardwareCostUsd',
]);

function fromRow<T>(columns: readonly string[], row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const c of columns) {
    const v = row[snake(c)];
    if (v === null || v === undefined) out[c] = null;
    else if (v instanceof Date)
      out[c] = c === 'date' ? v.toISOString().slice(0, 10) : v.toISOString();
    else if (NUMERIC_FIELDS.has(c) && typeof v === 'string') out[c] = Number(v);
    else out[c] = v;
  }
  return out as T;
}

async function insertMany<T extends object>(
  client: pg.PoolClient,
  table: string,
  columns: readonly (keyof T & string)[],
  rows: readonly T[],
): Promise<void> {
  for (const row of rows) {
    const values = columns.map((c) => (row as Record<string, unknown>)[c] ?? null);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    await client.query(
      `INSERT INTO ${table} (${columns.map(snake).join(', ')}) VALUES (${placeholders})`,
      values,
    );
  }
}

/** Tables: data/migrations/pending/group-intelligence.sql. */
export class PostgresWarehouse implements Warehouse {
  constructor(private readonly pool: pg.Pool) {}

  async replaceDay(
    date: string,
    institutionIds: readonly string[],
    rows: { institutions: InstitutionDaily[]; campuses: CampusDaily[]; costs: CostDaily[] },
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const table of ['group_institution_daily', 'group_campus_daily', 'group_cost_daily']) {
        await client.query(
          `DELETE FROM ${table} WHERE date = $1 AND institution_id = ANY($2::uuid[])`,
          [date, institutionIds],
        );
      }
      await insertMany(client, 'group_institution_daily', INSTITUTION_COLUMNS, rows.institutions);
      await insertMany(client, 'group_campus_daily', CAMPUS_COLUMNS, rows.campuses);
      await insertMany(client, 'group_cost_daily', COST_COLUMNS, rows.costs);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async select<T>(table: string, columns: readonly string[], q: FactQuery): Promise<T[]> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE institution_id = ANY($1::uuid[]) AND date BETWEEN $2 AND $3 ORDER BY date`,
      [q.institutionIds, q.from, q.to],
    );
    return r.rows.map((row) => fromRow<T>(columns, row));
  }

  institutionDaily(q: FactQuery): Promise<InstitutionDaily[]> {
    return this.select('group_institution_daily', INSTITUTION_COLUMNS, q);
  }

  campusDaily(q: FactQuery): Promise<CampusDaily[]> {
    return this.select('group_campus_daily', CAMPUS_COLUMNS, q);
  }

  costDaily(q: FactQuery): Promise<CostDaily[]> {
    return this.select('group_cost_daily', COST_COLUMNS, q);
  }

  async dataThrough(institutionIds: readonly string[]): Promise<string | null> {
    const r = await this.pool.query<{ d: Date | string | null }>(
      'SELECT max(date) AS d FROM group_institution_daily WHERE institution_id = ANY($1::uuid[])',
      [institutionIds],
    );
    const d = r.rows[0]?.d ?? null;
    return d instanceof Date ? d.toISOString().slice(0, 10) : d;
  }

  async saveRun(run: PipelineRun): Promise<void> {
    await this.pool.query(
      `INSERT INTO group_pipeline_runs (id, date, holding_company_ids, status, started_at, finished_at, institutions, errors)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        run.id,
        run.date,
        run.holdingCompanyIds,
        run.status,
        run.startedAt,
        run.finishedAt,
        run.institutions,
        JSON.stringify(run.errors),
      ],
    );
  }

  async listRuns(limit: number): Promise<PipelineRun[]> {
    const r = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM group_pipeline_runs ORDER BY started_at DESC LIMIT $1',
      [limit],
    );
    return r.rows.map((row) => ({
      id: String(row['id']),
      date:
        row['date'] instanceof Date ? row['date'].toISOString().slice(0, 10) : String(row['date']),
      holdingCompanyIds: row['holding_company_ids'] as string[],
      status: row['status'] as PipelineRun['status'],
      startedAt: (row['started_at'] as Date).toISOString(),
      finishedAt: (row['finished_at'] as Date).toISOString(),
      institutions: Number(row['institutions']),
      errors: row['errors'] as PipelineRun['errors'],
    }));
  }

  async addAllocation(a: CostAllocation): Promise<void> {
    await this.pool.query(
      `INSERT INTO group_cost_allocations (id, holding_company_id, institution_id, month, category, amount_usd, note, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        a.id,
        a.holdingCompanyId,
        a.institutionId,
        a.month,
        a.category,
        a.amountUsd,
        a.note,
        a.createdAt,
      ],
    );
  }

  private toAllocation(row: Record<string, unknown>): CostAllocation {
    return {
      id: String(row['id']),
      holdingCompanyId: String(row['holding_company_id']),
      institutionId: String(row['institution_id']),
      month: String(row['month']),
      category: 'compute',
      amountUsd: Number(row['amount_usd']),
      note: (row['note'] as string | null) ?? null,
      createdAt: (row['created_at'] as Date).toISOString(),
    };
  }

  async allocations(institutionIds: readonly string[], month: string): Promise<CostAllocation[]> {
    const r = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM group_cost_allocations WHERE institution_id = ANY($1::uuid[]) AND month = $2',
      [institutionIds, month],
    );
    return r.rows.map((row) => this.toAllocation(row));
  }

  async listAllocations(holdingCompanyId: string): Promise<CostAllocation[]> {
    const r = await this.pool.query<Record<string, unknown>>(
      'SELECT * FROM group_cost_allocations WHERE holding_company_id = $1 ORDER BY month DESC, created_at DESC',
      [holdingCompanyId],
    );
    return r.rows.map((row) => this.toAllocation(row));
  }
}

// ---------------------------------------------------------------- BigQuery (REST, untested)

export interface BigQueryOptions {
  projectId: string;
  dataset: string;
  location?: string;
  /** Returns an OAuth2 access token; defaults to the GCE/Cloud Run metadata server. */
  accessToken?: () => Promise<string>;
}

type BqParam = { name: string; type: string; value: unknown; array?: boolean };

async function metadataToken(): Promise<string> {
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) },
  );
  if (!res.ok) throw new Error(`metadata token HTTP ${res.status}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('metadata token missing');
  return body.access_token;
}

const bqParam = (p: BqParam): Record<string, unknown> =>
  p.array
    ? {
        name: p.name,
        parameterType: { type: 'ARRAY', arrayType: { type: p.type } },
        parameterValue: { arrayValues: (p.value as unknown[]).map((v) => ({ value: String(v) })) },
      }
    : {
        name: p.name,
        parameterType: { type: p.type },
        parameterValue: { value: p.value === null ? null : String(p.value) },
      };

/**
 * BigQuery adapter via the REST `jobs.query` API (DML, not streaming inserts, so a re-run can
 * DELETE the day it replaces). Tables are created by Terraform (modules/bigquery) from
 * data/bigquery/*.sql. Not exercised in this repository's tests — no GCP credentials here.
 */
export class BigQueryWarehouse implements Warehouse {
  constructor(private readonly opts: BigQueryOptions) {}

  private table(name: string): string {
    return `\`${this.opts.projectId}.${this.opts.dataset}.${name}\``;
  }

  private async query(sql: string, params: BqParam[] = []): Promise<Record<string, unknown>[]> {
    const token = await (this.opts.accessToken ?? metadataToken)();
    const res = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${this.opts.projectId}/queries`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          query: sql,
          useLegacySql: false,
          parameterMode: 'NAMED',
          queryParameters: params.map(bqParam),
          location: this.opts.location ?? 'southamerica-east1',
          timeoutMs: 30_000,
        }),
      },
    );
    if (!res.ok) throw new Error(`BigQuery HTTP ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      schema?: { fields: { name: string }[] };
      rows?: { f: { v: unknown }[] }[];
    };
    const fields = body.schema?.fields.map((f) => f.name) ?? [];
    return (body.rows ?? []).map((r) =>
      Object.fromEntries(r.f.map((cell, i) => [fields[i] ?? `c${i}`, cell.v])),
    );
  }

  private literal(v: unknown): string {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }

  private insertSql<T extends object>(
    table: string,
    columns: readonly (keyof T & string)[],
    rows: readonly T[],
  ): string {
    if (rows.length === 0) return '';
    const values = rows
      .map(
        (r) =>
          `(${columns.map((c) => this.literal((r as Record<string, unknown>)[c])).join(', ')})`,
      )
      .join(',\n');
    return `INSERT INTO ${this.table(table)} (${columns.map(snake).join(', ')}) VALUES ${values};`;
  }

  async replaceDay(
    date: string,
    institutionIds: readonly string[],
    rows: { institutions: InstitutionDaily[]; campuses: CampusDaily[]; costs: CostDaily[] },
  ): Promise<void> {
    const deletes = ['institution_daily', 'campus_daily', 'cost_daily']
      .map(
        (t) =>
          `DELETE FROM ${this.table(t)} WHERE date = @date AND institution_id IN UNNEST(@ids);`,
      )
      .join('\n');
    const script = [
      'BEGIN TRANSACTION;',
      deletes,
      this.insertSql('institution_daily', INSTITUTION_COLUMNS, rows.institutions),
      this.insertSql('campus_daily', CAMPUS_COLUMNS, rows.campuses),
      this.insertSql('cost_daily', COST_COLUMNS, rows.costs),
      'COMMIT TRANSACTION;',
    ].join('\n');
    await this.query(script, [
      { name: 'date', type: 'DATE', value: date },
      { name: 'ids', type: 'STRING', value: institutionIds, array: true },
    ]);
  }

  private async select<T>(table: string, columns: readonly string[], q: FactQuery): Promise<T[]> {
    const rows = await this.query(
      `SELECT * FROM ${this.table(table)} WHERE institution_id IN UNNEST(@ids) AND date BETWEEN @from AND @to ORDER BY date`,
      [
        { name: 'ids', type: 'STRING', value: q.institutionIds, array: true },
        { name: 'from', type: 'DATE', value: q.from },
        { name: 'to', type: 'DATE', value: q.to },
      ],
    );
    return rows.map((row) => fromRow<T>(columns, row));
  }

  institutionDaily(q: FactQuery): Promise<InstitutionDaily[]> {
    return this.select('institution_daily', INSTITUTION_COLUMNS, q);
  }

  campusDaily(q: FactQuery): Promise<CampusDaily[]> {
    return this.select('campus_daily', CAMPUS_COLUMNS, q);
  }

  costDaily(q: FactQuery): Promise<CostDaily[]> {
    return this.select('cost_daily', COST_COLUMNS, q);
  }

  async dataThrough(institutionIds: readonly string[]): Promise<string | null> {
    const rows = await this.query(
      `SELECT CAST(MAX(date) AS STRING) AS d FROM ${this.table('institution_daily')} WHERE institution_id IN UNNEST(@ids)`,
      [{ name: 'ids', type: 'STRING', value: institutionIds, array: true }],
    );
    const d = rows[0]?.['d'];
    return typeof d === 'string' ? d : null;
  }

  async saveRun(run: PipelineRun): Promise<void> {
    await this.query(
      `INSERT INTO ${this.table('pipeline_runs')} (id, date, status, started_at, finished_at, institutions, details)
       VALUES (@id, @date, @status, @started, @finished, @institutions, @details)`,
      [
        { name: 'id', type: 'STRING', value: run.id },
        { name: 'date', type: 'DATE', value: run.date },
        { name: 'status', type: 'STRING', value: run.status },
        { name: 'started', type: 'TIMESTAMP', value: run.startedAt },
        { name: 'finished', type: 'TIMESTAMP', value: run.finishedAt },
        { name: 'institutions', type: 'INT64', value: run.institutions },
        {
          name: 'details',
          type: 'STRING',
          value: JSON.stringify({ holdingCompanyIds: run.holdingCompanyIds, errors: run.errors }),
        },
      ],
    );
  }

  async listRuns(limit: number): Promise<PipelineRun[]> {
    const rows = await this.query(
      `SELECT id, CAST(date AS STRING) AS date, status, CAST(started_at AS STRING) AS started_at,
              CAST(finished_at AS STRING) AS finished_at, institutions, details
       FROM ${this.table('pipeline_runs')} ORDER BY started_at DESC LIMIT @limit`,
      [{ name: 'limit', type: 'INT64', value: limit }],
    );
    return rows.map((r) => {
      const details = JSON.parse(String(r['details'] ?? '{}')) as {
        holdingCompanyIds?: string[];
        errors?: PipelineRun['errors'];
      };
      return {
        id: String(r['id']),
        date: String(r['date']),
        holdingCompanyIds: details.holdingCompanyIds ?? [],
        status: String(r['status']) as PipelineRun['status'],
        startedAt: String(r['started_at']),
        finishedAt: String(r['finished_at']),
        institutions: Number(r['institutions']),
        errors: details.errors ?? [],
      };
    });
  }

  async addAllocation(a: CostAllocation): Promise<void> {
    await this.query(
      `INSERT INTO ${this.table('cost_allocations')} (id, holding_company_id, institution_id, month, category, amount_usd, note, created_at)
       VALUES (@id, @hc, @inst, @month, @category, @amount, @note, @created)`,
      [
        { name: 'id', type: 'STRING', value: a.id },
        { name: 'hc', type: 'STRING', value: a.holdingCompanyId },
        { name: 'inst', type: 'STRING', value: a.institutionId },
        { name: 'month', type: 'STRING', value: a.month },
        { name: 'category', type: 'STRING', value: a.category },
        { name: 'amount', type: 'NUMERIC', value: a.amountUsd },
        { name: 'note', type: 'STRING', value: a.note },
        { name: 'created', type: 'TIMESTAMP', value: a.createdAt },
      ],
    );
  }

  private toAllocation(r: Record<string, unknown>): CostAllocation {
    return {
      id: String(r['id']),
      holdingCompanyId: String(r['holding_company_id']),
      institutionId: String(r['institution_id']),
      month: String(r['month']),
      category: 'compute',
      amountUsd: Number(r['amount_usd']),
      note: r['note'] === null || r['note'] === undefined ? null : String(r['note']),
      createdAt: String(r['created_at']),
    };
  }

  async allocations(institutionIds: readonly string[], month: string): Promise<CostAllocation[]> {
    const rows = await this.query(
      `SELECT * FROM ${this.table('cost_allocations')} WHERE institution_id IN UNNEST(@ids) AND month = @month`,
      [
        { name: 'ids', type: 'STRING', value: institutionIds, array: true },
        { name: 'month', type: 'STRING', value: month },
      ],
    );
    return rows.map((r) => this.toAllocation(r));
  }

  async listAllocations(holdingCompanyId: string): Promise<CostAllocation[]> {
    const rows = await this.query(
      `SELECT * FROM ${this.table('cost_allocations')} WHERE holding_company_id = @hc ORDER BY month DESC`,
      [{ name: 'hc', type: 'STRING', value: holdingCompanyId }],
    );
    return rows.map((r) => this.toAllocation(r));
  }
}
