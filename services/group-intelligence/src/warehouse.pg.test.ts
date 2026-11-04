import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CampusDaily, CostDaily, InstitutionDaily } from './domain.js';
import { PostgresWarehouse } from './warehouse.js';

/** Runs only when TEST_DATABASE_URL points at a server where a scratch database can be created. */
const ADMIN_URL = process.env['TEST_DATABASE_URL'];
const MIGRATION = fileURLToPath(
  new URL('../../../data/migrations/pending/group-intelligence.sql', import.meta.url),
);

const HC = '10000000-0000-4000-8000-000000000001';
const INST = '20000000-0000-4000-8000-00000000000a';
const CAMPUS = '30000000-0000-4000-8000-0000000000a1';

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

const row = (date: string, activeStudents: number | null): InstitutionDaily => ({
  holdingCompanyId: HC,
  institutionId: INST,
  date,
  classesScheduled: 30,
  classesCaptured: 27,
  classesTranscribed: 26,
  classesStructured: 25,
  eventsExtracted: 10,
  eventsReviewed: 8,
  professorsTeaching: 6,
  activeProfessors: 4,
  activeStudents,
  assistantQuestions: activeStudents === null ? null : 19,
  searches: activeStudents === null ? null : 35,
  devicesTotal: 10,
  devicesOnline: 8,
  deviceUptimePct: 80,
  firmwareCurrentPct: 90,
  incidentsOpened: 2,
  incidentsResolved: 1,
  mttrMinutes: 45,
  aiCostUsd: 1.25,
  sttCostUsd: 37.44,
  storageCostUsd: 0.321926,
  infraCostUsd: 4.166667,
  builtAt: '2026-11-10T12:00:00.000Z',
});

describe.skipIf(!ADMIN_URL)('PostgresWarehouse', () => {
  const dbName = `ci_test_${randomBytes(4).toString('hex')}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let wh: PostgresWarehouse;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    pool = new pg.Pool({ connectionString: withDatabase(ADMIN_URL!, dbName) });
    await pool.query(readFileSync(MIGRATION, 'utf8'));
    wh = new PostgresWarehouse(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it('replaces a day atomically and reads facts back with numeric types', async () => {
    const campus: CampusDaily = {
      holdingCompanyId: HC,
      institutionId: INST,
      campusId: CAMPUS,
      date: '2026-11-03',
      classesScheduled: 20,
      classesCaptured: 18,
      devicesTotal: 7,
      devicesOnline: 6,
      sttCostUsd: 24.96,
      storageCostUsd: 0.214618,
      hardwareCostUsd: 2.916667,
      builtAt: '2026-11-10T12:00:00.000Z',
    };
    const cost: CostDaily = {
      holdingCompanyId: HC,
      institutionId: INST,
      campusId: null,
      date: '2026-11-03',
      category: 'ai',
      amountUsd: 1.25,
      source: 'ai-gateway:/v1/usage',
    };
    await wh.replaceDay('2026-11-03', [INST], {
      institutions: [row('2026-11-03', 52)],
      campuses: [campus],
      costs: [cost],
    });
    await wh.replaceDay('2026-11-03', [INST], {
      institutions: [row('2026-11-03', null)],
      campuses: [campus],
      costs: [cost],
    });
    await wh.replaceDay('2026-11-04', [INST], {
      institutions: [row('2026-11-04', 60)],
      campuses: [],
      costs: [],
    });

    const q = { institutionIds: [INST], from: '2026-11-01', to: '2026-11-30' };
    const facts = await wh.institutionDaily(q);
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({
      date: '2026-11-03',
      activeStudents: null,
      aiCostUsd: 1.25,
      deviceUptimePct: 80,
    });
    expect(facts[1]).toMatchObject({ date: '2026-11-04', activeStudents: 60, searches: 35 });
    expect(await wh.campusDaily(q)).toEqual([
      expect.objectContaining({ campusId: CAMPUS, hardwareCostUsd: 2.916667 }),
    ]);
    expect(await wh.costDaily(q)).toHaveLength(1);
    expect(await wh.dataThrough([INST])).toBe('2026-11-04');
  });

  it('enforces the cohort rule in the schema', async () => {
    await expect(
      wh.replaceDay('2026-11-05', [INST], {
        institutions: [{ ...row('2026-11-05', 52), activeStudents: 3 }],
        campuses: [],
        costs: [],
      }),
    ).rejects.toThrow();
    // The failed transaction left nothing behind.
    expect(
      await wh.institutionDaily({ institutionIds: [INST], from: '2026-11-05', to: '2026-11-05' }),
    ).toHaveLength(0);
  });

  it('stores pipeline runs and cost allocations', async () => {
    const run = {
      id: randomUUID(),
      date: '2026-11-03',
      holdingCompanyIds: [HC],
      status: 'completed' as const,
      startedAt: '2026-11-10T12:00:00.000Z',
      finishedAt: '2026-11-10T12:00:05.000Z',
      institutions: 1,
      errors: [],
    };
    await wh.saveRun(run);
    expect(await wh.listRuns(5)).toEqual([run]);
    await wh.addAllocation({
      id: randomUUID(),
      holdingCompanyId: HC,
      institutionId: INST,
      month: '2026-11',
      category: 'compute',
      amountUsd: 3000,
      note: 'Cloud Run',
      createdAt: '2026-11-10T12:00:00.000Z',
    });
    expect((await wh.allocations([INST], '2026-11'))[0]).toMatchObject({
      amountUsd: 3000,
      note: 'Cloud Run',
    });
    expect(await wh.listAllocations(HC)).toHaveLength(1);
  });
});
