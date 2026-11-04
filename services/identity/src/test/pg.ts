/**
 * Throwaway PostgreSQL databases for *.pg.test.ts (integration stage §1).
 * TEST_DATABASE_URL is the admin URL of an empty server; each test file gets `ci_test_<random>` with every
 * migration (data/migrations/V*.sql, then pending/*.sql) applied, and drops it afterwards.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../data/migrations',
);

export interface TestDatabase {
  name: string;
  pool: pg.Pool;
  drop(): Promise<void>;
}

function withDatabase(adminUrl: string, database: string): string {
  // Not `new URL()`: socket URLs such as postgresql://ci@/postgres?host=/var/run have an empty host.
  const [base = '', query] = adminUrl.split('?', 2);
  const swapped = base.replace(/\/[^/]*$/, `/${database}`);
  return query === undefined ? swapped : `${swapped}?${query}`;
}

async function migrationFiles(): Promise<string[]> {
  const versioned = (await readdir(MIGRATIONS_DIR))
    .filter((f) => /^V\d+__.*\.sql$/.test(f))
    .sort()
    .map((f) => join(MIGRATIONS_DIR, f));
  const pendingDir = join(MIGRATIONS_DIR, 'pending');
  const pending = (await readdir(pendingDir).catch(() => [] as string[]))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(pendingDir, f));
  return [...versioned, ...pending];
}

export async function createTestDatabase(adminUrl: string): Promise<TestDatabase> {
  const name = `ci_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const migrator = new pg.Client({ connectionString: withDatabase(adminUrl, name) });
  await migrator.connect();
  try {
    for (const file of await migrationFiles()) {
      try {
        await migrator.query(await readFile(file, 'utf8'));
      } catch (err) {
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await migrator.end();
  }

  const pool = new pg.Pool({ connectionString: withDatabase(adminUrl, name), max: 8 });
  return {
    name,
    pool,
    async drop(): Promise<void> {
      await pool.end();
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}

/** Minimal academic rows required by identity's foreign keys. */
export async function seedInstitutions(
  pool: pg.Pool,
  institutionIds: readonly string[],
): Promise<string> {
  const holding = randomUUID();
  await pool.query('INSERT INTO holding_companies (id, name, legal_name) VALUES ($1, $2, $3)', [
    holding,
    'Grupo Teste',
    'Grupo Teste S.A.',
  ]);
  for (const id of institutionIds) {
    await pool.query(
      'INSERT INTO institutions (id, holding_company_id, name, state) VALUES ($1, $2, $3, $4)',
      [id, holding, `Instituição ${id.slice(0, 4)}`, 'SP'],
    );
  }
  return holding;
}

export async function insertPerson(
  pool: pg.Pool,
  institutionId: string,
  kind: 'student' | 'professor',
): Promise<string> {
  const id = randomUUID();
  const table = kind === 'student' ? 'students' : 'professors';
  await pool.query(
    `INSERT INTO ${table} (id, institution_id, name, email) VALUES ($1, $2, $3, $4)`,
    [id, institutionId, `${kind} ${id.slice(0, 6)}`, `${kind}-${id.slice(0, 8)}@example.edu.br`],
  );
  return id;
}
