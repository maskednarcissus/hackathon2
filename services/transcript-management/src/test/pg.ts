/**
 * Fresh database per test file (integration-stage contract §1): created on the TEST_DATABASE_URL
 * server, all migrations (V*.sql then pending/*.sql) applied in order, dropped afterwards.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const MIGRATIONS = fileURLToPath(new URL('../../../../data/migrations/', import.meta.url));

function urlFor(adminUrl: string, database: string): string {
  // Works for postgresql://user@host:port/db and the socket form postgresql://user@/db?host=/dir&port=…
  const m = /^(postgres(?:ql)?:\/\/[^/?]*)(\/[^?]*)?(\?.*)?$/.exec(adminUrl);
  if (!m) throw new Error('Unsupported TEST_DATABASE_URL');
  return `${m[1] ?? ''}/${database}${m[3] ?? ''}`;
}

export interface TestDatabase {
  url: string;
  pool: pg.Pool;
  drop(): Promise<void>;
}

export async function createTestDatabase(adminUrl: string): Promise<TestDatabase> {
  const name = `ci_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = urlFor(adminUrl, name);
  const setup = new pg.Client({ connectionString: url });
  await setup.connect();
  try {
    const versioned = readdirSync(MIGRATIONS)
      .filter((f) => /^V\d+__.*\.sql$/.test(f))
      .sort();
    let pending: string[] = [];
    try {
      pending = readdirSync(`${MIGRATIONS}pending`)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    } catch {
      pending = [];
    }
    for (const f of versioned) await setup.query(readFileSync(`${MIGRATIONS}${f}`, 'utf8'));
    for (const f of pending) {
      try {
        await setup.query(readFileSync(`${MIGRATIONS}pending/${f}`, 'utf8'));
      } catch (err) {
        throw new Error(`pending migration ${f} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await setup.end();
  }
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  return {
    url,
    pool,
    async drop() {
      await pool.end();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

/** Minimal organisational rows that most foreign keys need. Returns ids. */
export async function seedOrganization(
  pool: pg.Pool,
  ids: { holdingId: string; institutionId: string; campusId?: string; classroomIds?: string[] },
): Promise<void> {
  await pool.query(
    `INSERT INTO holding_companies (id, name, legal_name) VALUES ($1, 'Grupo Teste', 'Grupo Teste S.A.') ON CONFLICT DO NOTHING`,
    [ids.holdingId],
  );
  await pool.query(
    `INSERT INTO institutions (id, holding_company_id, name, state) VALUES ($1, $2, $3, 'SP') ON CONFLICT DO NOTHING`,
    [ids.institutionId, ids.holdingId, `Instituição ${ids.institutionId.slice(0, 8)}`],
  );
  if (ids.campusId) {
    await pool.query(
      `INSERT INTO campuses (id, institution_id, name, city, state) VALUES ($1, $2, $3, 'São Paulo', 'SP') ON CONFLICT DO NOTHING`,
      [ids.campusId, ids.institutionId, `Campus ${ids.campusId.slice(0, 8)}`],
    );
    for (const [i, classroomId] of (ids.classroomIds ?? []).entries()) {
      await pool.query(
        `INSERT INTO classrooms (id, campus_id, name, code) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [classroomId, ids.campusId, `Sala ${i + 1}`, `S${i + 1}-${classroomId.slice(0, 4)}`],
      );
    }
  }
}
