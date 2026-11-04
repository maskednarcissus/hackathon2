/**
 * Throwaway PostgreSQL databases for *.pg.test.ts (same harness as services/identity/src/test/pg.ts) (integration stage §1).
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

export interface AcademicSeed {
  institutionId: string;
  courseIds: [string, string];
  sectionIds: [string, string];
  studentIds: string[];
}

/** Holding → institution → program/term → two courses with one section each, and students. */
export async function seedAcademic(pool: pg.Pool, students = 4): Promise<AcademicSeed> {
  const q = async (sql: string, params: unknown[]): Promise<string> => {
    const r = await pool.query<{ id: string }>(sql, params);
    return r.rows[0]?.id ?? '';
  };
  const holding = await q(
    'INSERT INTO holding_companies (name, legal_name) VALUES ($1, $2) RETURNING id',
    ['Grupo Teste', 'Grupo Teste S.A.'],
  );
  const institutionId = await q(
    'INSERT INTO institutions (holding_company_id, name, state) VALUES ($1, $2, $3) RETURNING id',
    [holding, 'Universidade Teste', 'SP'],
  );
  const program = await q(
    'INSERT INTO academic_programs (institution_id, name, code) VALUES ($1, $2, $3) RETURNING id',
    [institutionId, 'Engenharia', 'ENG-' + randomUUID().slice(0, 6)],
  );
  const term = await q(
    'INSERT INTO academic_terms (institution_id, name, start_date, end_date) VALUES ($1, $2, $3, $4) RETURNING id',
    [institutionId, '2026.2', '2026-08-01', '2026-12-15'],
  );
  const professor = await q(
    'INSERT INTO professors (institution_id, name, email) VALUES ($1, $2, $3) RETURNING id',
    [institutionId, 'Prof. Teste', 'prof-' + randomUUID().slice(0, 8) + '@example.edu.br'],
  );
  const courseIds: string[] = [];
  const sectionIds: string[] = [];
  for (const [code, name] of [
    ['CALC1', 'Cálculo I'],
    ['FIS1', 'Física I'],
  ] as const) {
    const course = await q(
      'INSERT INTO courses (institution_id, academic_program_id, academic_term_id, code, name, discipline) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [institutionId, program, term, code, name, 'engenharia'],
    );
    courseIds.push(course);
    sectionIds.push(
      await q(
        'INSERT INTO class_sections (course_id, professor_id, section_code) VALUES ($1, $2, $3) RETURNING id',
        [course, professor, 'T1'],
      ),
    );
  }
  const studentIds: string[] = [];
  for (let i = 0; i < students; i += 1) {
    studentIds.push(
      await q(
        'INSERT INTO students (institution_id, name, email) VALUES ($1, $2, $3) RETURNING id',
        [institutionId, 'Aluno ' + i, 'aluno-' + randomUUID().slice(0, 8) + '@example.edu.br'],
      ),
    );
  }
  return {
    institutionId,
    courseIds: courseIds as [string, string],
    sectionIds: sectionIds as [string, string],
    studentIds,
  };
}
