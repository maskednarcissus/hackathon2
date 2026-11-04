/**
 * Integration-test database (integration stage §1): a fresh `ci_test_<random>` database with
 * every migration applied, plus this service's pending schema file. Skipped unless
 * `TEST_DATABASE_URL` (admin URL of a server) is set.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../data/migrations',
);

/** Replaces the database name in a connection string (works with socket URLs like `ci@/postgres?host=…`). */
export function withDatabase(url: string, database: string): string {
  return url.replace(/^(postgres(?:ql)?:\/\/[^/]*\/)([^?]*)/, `$1${database}`);
}

export function migrationFiles(pendingFiles: readonly string[]): string[] {
  const versioned = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^V\d+__.*\.sql$/.test(f))
    .sort()
    .map((f) => join(MIGRATIONS_DIR, f));
  const pending = pendingFiles
    .map((f) => join(MIGRATIONS_DIR, 'pending', f))
    .filter((f) => existsSync(f));
  return [...versioned, ...pending];
}

export interface TestDatabase {
  connectionString: string;
  pool: pg.Pool;
  drop(): Promise<void>;
}

export async function createTestDatabase(
  adminUrl: string,
  pendingFiles: readonly string[],
): Promise<TestDatabase> {
  const name = `ci_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const connectionString = withDatabase(adminUrl, name);
  const setup = new pg.Client({ connectionString });
  await setup.connect();
  try {
    for (const file of migrationFiles(pendingFiles)) await setup.query(readFileSync(file, 'utf8'));
  } finally {
    await setup.end();
  }
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    connectionString,
    pool,
    async drop(): Promise<void> {
      await pool.end();
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
