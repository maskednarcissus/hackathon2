/**
 * Postgres test harness (integration stage §1): creates a fresh `ci_test_<random>` database on the
 * server given by TEST_DATABASE_URL, applies data/migrations/V*.sql in order plus
 * data/migrations/pending/notifications.sql, and drops it afterwards.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createPool } from '../db.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../data/migrations');

export function migrationFiles(): string[] {
  const versioned = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^V\d+__.*\.sql$/.test(f))
    .sort((a, b) => Number(a.slice(1, a.indexOf('__'))) - Number(b.slice(1, b.indexOf('__'))))
    .map((f) => join(MIGRATIONS_DIR, f));
  return [...versioned, join(MIGRATIONS_DIR, 'pending', 'notifications.sql')];
}

/** Swaps the database name; works for socket URLs like `postgresql://ci@/postgres?host=/tmp` too. */
export function withDatabase(url: string, database: string): string {
  const match = /^(postgres(?:ql)?:\/\/[^/]*)(?:\/([^?]*))?(\?.*)?$/.exec(url);
  if (!match) throw new Error('unsupported TEST_DATABASE_URL');
  return `${match[1]}/${database}${match[3] ?? ''}`;
}

export interface TestDatabase {
  pool: pg.Pool;
  institutionId: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL not set');
  const name = `ci_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const pool = createPool(withDatabase(TEST_DATABASE_URL, name));
  for (const file of migrationFiles()) {
    try {
      await pool.query(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }
  const holding = await pool.query<{ id: string }>(
    "INSERT INTO holding_companies (name, legal_name) VALUES ('Grupo Teste', 'Grupo Teste S.A.') RETURNING id",
  );
  const institution = await pool.query<{ id: string }>(
    "INSERT INTO institutions (holding_company_id, name, state) VALUES ($1, 'Faculdade Teste', 'SP') RETURNING id",
    [holding.rows[0]!.id],
  );

  return {
    pool,
    institutionId: institution.rows[0]!.id,
    drop: async () => {
      await pool.end();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
