/**
 * Postgres behavioural suite (integration stage §1). Runs only with TEST_DATABASE_URL, e.g.
 *   TEST_DATABASE_URL='postgresql://ci@/postgres?host=/var/tmp/cipg&port=5433' pnpm test
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import {
  InMemoryAuditClient,
  StaticRosterClient,
  type RetentionCandidate,
  type RetentionTarget,
} from './clients.js';
import type { RetentionKind } from './domain.js';
import type { OrganizationRepository } from './repository.js';
import { createPgOrganizationRepository } from './repository.pg.js';
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from './test/pgdb.js';

const ACTOR = '99999999-0000-4000-8000-000000000001';
const PROF = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const S1 = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const S2 = 'bbbbbbbb-0000-4000-8000-0000000000b2';
const SECTION = 'cccccccc-0000-4000-8000-0000000000c1';

/** academic-integration owns class sections; seed the minimal chain the consent FK needs. */
async function seedSection(pool: pg.Pool, institutionId: string): Promise<void> {
  const program = await pool.query<{ id: string }>(
    `INSERT INTO academic_programs (institution_id, name, code) VALUES ($1, 'Direito', 'DIR') RETURNING id`,
    [institutionId],
  );
  const term = await pool.query<{ id: string }>(
    `INSERT INTO academic_terms (institution_id, name, start_date, end_date)
     VALUES ($1, '2026.2', '2026-08-01', '2026-12-15') RETURNING id`,
    [institutionId],
  );
  const course = await pool.query<{ id: string }>(
    `INSERT INTO courses (institution_id, academic_program_id, academic_term_id, code, name, discipline)
     VALUES ($1, $2, $3, 'DIR101', 'Direito Civil', 'law') RETURNING id`,
    [institutionId, program.rows[0]?.id, term.rows[0]?.id],
  );
  await pool.query(
    `INSERT INTO professors (id, institution_id, name, email) VALUES ($1, $2, 'Prof', 'p@x.br')`,
    [PROF, institutionId],
  );
  await pool.query(
    `INSERT INTO class_sections (id, course_id, professor_id, section_code, institution_id)
     VALUES ($1, $2, $3, 'A', $4)`,
    [SECTION, course.rows[0]?.id, PROF, institutionId],
  );
}

class GatedTarget implements RetentionTarget {
  readonly name = 'audio-ingestion';
  readonly kinds: readonly RetentionKind[] = ['audio'];
  items: (RetentionCandidate & { createdAt: string })[] = [];
  gate: Promise<void> | undefined;
  candidates(q: { olderThan: string }): Promise<RetentionCandidate[]> {
    const items = this.items.filter((i) => i.createdAt <= q.olderThan);
    return (this.gate ?? Promise.resolve()).then(() => items);
  }
  delete(r: { ids: string[] }): Promise<string[]> {
    this.items = this.items.filter((i) => !r.ids.includes(i.id));
    return Promise.resolve(r.ids);
  }
}

describe.skipIf(!TEST_DATABASE_URL)('organization on Postgres', () => {
  let db: TestDatabase;
  let repo: OrganizationRepository;
  let app: FastifyInstance;
  let audit: InMemoryAuditClient;
  let target: GatedTarget;
  let roster: StaticRosterClient;
  let institutionId: string;
  let campusId: string;
  let classroomId: string;
  const clock = { now: (): Date => new Date('2026-11-04T12:00:00.000Z') };

  const req = async <T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ): Promise<{ status: number; body: T }> => {
    const res = await app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
  };

  beforeAll(async () => {
    db = await createTestDatabase(TEST_DATABASE_URL ?? '', ['organization.sql']);
    repo = createPgOrganizationRepository(db.pool);
  }, 60_000);
  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE retention_jobs, legal_holds, recording_consents, class_sections, courses,
         academic_terms, academic_programs, professors, classrooms, campuses,
         recording_policy_versions, recording_policies, institutions, holding_companies CASCADE`,
    );
    audit = new InMemoryAuditClient();
    target = new GatedTarget();
    roster = new StaticRosterClient();
    app = buildApp({ deps: { repo, audit, roster, clock, retentionTargets: [target] } });
    const h = await req('POST', '/v1/holding-companies', {
      name: 'Grupo',
      legalName: 'Grupo S.A.',
    });
    const i = await req('POST', '/v1/institutions', {
      holdingCompanyId: h.body['id'],
      name: 'Universidade',
      state: 'SP',
      brand: 'UNI',
    });
    institutionId = i.body['id'] as string;
    const c = await req('POST', '/v1/campuses', {
      institutionId,
      name: 'Centro',
      city: 'SP',
      state: 'SP',
    });
    campusId = c.body['id'] as string;
    const r = await req('POST', '/v1/classrooms', {
      campusId,
      name: 'Sala',
      code: 'R1',
      capacity: 40,
    });
    classroomId = r.body['id'] as string;
    await seedSection(db.pool, institutionId);
    roster.rosters.set(SECTION, {
      classSectionId: SECTION,
      institutionId,
      professorIds: [PROF],
      studentIds: [S1, S2],
    });
  });

  it('persists the hierarchy and resolves classroom tenant data', async () => {
    const room = await req('GET', `/v1/classrooms/${classroomId}`);
    expect(room.body).toMatchObject({
      institutionId,
      campusId,
      campusName: 'Centro',
      capacity: 40,
      timezone: 'America/Sao_Paulo',
    });
    const tree = await req<{
      institution: { brand: string };
      campuses: { classrooms: unknown[] }[];
    }>('GET', `/v1/institutions/${institutionId}/tree`);
    expect(tree.body.institution.brand).toBe('UNI');
    expect(tree.body.campuses[0]?.classrooms).toHaveLength(1);
    // Case-insensitive classroom code uniqueness is also enforced by the database.
    await expect(
      db.pool.query(`INSERT INTO classrooms (campus_id, name, code) VALUES ($1, 'Dup', 'r1')`, [
        campusId,
      ]),
    ).rejects.toThrow(/uq_classrooms_code_ci/);
  });

  it('appends immutable versions atomically and switches the default', async () => {
    const a = await req<{ id: string; currentVersion: number }>(
      'POST',
      `/v1/institutions/${institutionId}/recording-policies`,
      { name: 'A', legalBasis: 'consent', actorId: ACTOR },
    );
    expect(a.status).toBe(201);
    const patched = await req<{ currentVersion: number }>(
      'PATCH',
      `/v1/recording-policies/${a.body.id}`,
      {
        audioRetentionDays: 30,
        changeReason: 'LGPD',
        actorId: ACTOR,
      },
    );
    expect(patched.body.currentVersion).toBe(2);
    const versions = await req<{
      items: { version: number; createdBy: string; content: { audioRetentionDays: number } }[];
    }>('GET', `/v1/recording-policies/${a.body.id}/versions`);
    expect(versions.body.items.map((v) => v.version)).toEqual([2, 1]);
    expect(versions.body.items[1]?.content.audioRetentionDays).toBe(90);
    expect(versions.body.items[0]?.createdBy).toBe(ACTOR);
    await expect(
      db.pool.query('UPDATE recording_policy_versions SET change_reason = $1', ['tamper']),
    ).rejects.toThrow(/append-only/);

    const b = await req<{ id: string }>(
      'POST',
      `/v1/institutions/${institutionId}/recording-policies`,
      {
        name: 'B',
        legalBasis: 'consent',
        isDefault: true,
      },
    );
    const defaults = await db.pool.query<{ id: string }>(
      'SELECT id FROM recording_policies WHERE institution_id = $1 AND is_default',
      [institutionId],
    );
    expect(defaults.rows.map((r) => r.id)).toEqual([b.body.id]);
    const resolved = await req('GET', `/v1/classrooms/${classroomId}/recording-policy`);
    expect(resolved.body).toMatchObject({ source: 'institution_default', policyVersion: 1 });

    // Institutions with policies cannot be deleted (versions are kept for governance).
    await req('DELETE', `/v1/classrooms/${classroomId}`);
    await req('DELETE', `/v1/campuses/${campusId}`);
    expect((await req('DELETE', `/v1/institutions/${institutionId}`)).status).toBe(409);
  });

  it('records, supersedes and withdraws consent with the current-decision index', async () => {
    const policy = await req<{ id: string }>(
      'POST',
      `/v1/institutions/${institutionId}/recording-policies`,
      {
        name: 'Explícita',
        legalBasis: 'consent',
        requiresExplicitConsent: true,
      },
    );
    const give = (
      subjectId: string,
      type: 'student' | 'professor',
      given = true,
    ): Promise<{ status: number; body: { id: string } }> =>
      req('POST', '/v1/consents', {
        subjectType: type,
        subjectId,
        policyId: policy.body.id,
        classSectionId: SECTION,
        given,
        actorId: subjectId,
      });
    await give(PROF, 'professor');
    await give(S1, 'student', false);
    await give(S1, 'student', true); // supersedes the refusal
    const s2 = await give(S2, 'student');
    expect(s2.status).toBe(201);

    const status = await req('GET', `/v1/class-sections/${SECTION}/consent-status`);
    expect(status.body).toMatchObject({ studentsConsented: 2, recordingAllowed: true });
    const history = await req<{ items: { given: boolean; supersededBy?: string }[] }>(
      'GET',
      `/v1/consents?subjectId=${S1}&includeHistory=true`,
    );
    expect(history.body.items).toHaveLength(2);
    expect(history.body.items.find((c) => !c.given)?.supersededBy).toBeTruthy();

    // Concurrent decisions for the same scope never leave two current rows.
    await Promise.allSettled([give(S2, 'student', false), give(S2, 'student', true)]);
    const current = await db.pool.query(
      `SELECT id FROM recording_consents WHERE subject_id = $1 AND superseded_at IS NULL`,
      [S2],
    );
    expect(current.rows).toHaveLength(1);

    const latest = await req<{ items: { id: string; given: boolean }[] }>(
      'GET',
      `/v1/consents?subjectId=${S2}`,
    );
    const id = latest.body.items[0]?.id ?? '';
    if (latest.body.items[0]?.given) {
      expect((await req('POST', `/v1/consents/${id}/withdraw`, { actorId: S2 })).status).toBe(200);
    }
    const after = await req(
      'GET',
      `/v1/classrooms/${classroomId}/recording-policy?classSectionId=${SECTION}`,
    );
    expect(after.body).toMatchObject({ consentSatisfied: false });

    // Unknown class section → FK backstop surfaces as 422.
    const bad = await req('POST', '/v1/consents', {
      subjectType: 'student',
      subjectId: S1,
      policyId: policy.body.id,
      classSectionId: 'cccccccc-0000-4000-8000-0000000000ff',
      given: true,
      actorId: S1,
    });
    expect(bad.status).toBe(422);
  });

  it('runs retention with holds, persists jobs and allows one running job per institution', async () => {
    await req('POST', `/v1/institutions/${institutionId}/recording-policies`, {
      name: 'P',
      legalBasis: 'legitimate_interest',
      audioRetentionDays: 90,
    });
    const old = new Date(clock.now().getTime() - 100 * 86_400_000).toISOString();
    target.items = [
      { id: 'a1', createdAt: old, classSectionId: SECTION },
      { id: 'a2', createdAt: old },
    ];
    const hold = await req<{ id: string }>('POST', '/v1/legal-holds', {
      institutionId,
      scope: { type: 'class_section', id: SECTION },
      reason: 'Processo 123',
      actorId: ACTOR,
    });
    expect(hold.status).toBe(201);

    let release: () => void = () => undefined;
    target.gate = new Promise((resolve) => {
      release = resolve;
    });
    const first = req<{ id: string; status: string; kinds: { audio: Record<string, number> } }>(
      'POST',
      '/v1/retention/run',
      { institutionId, actorId: ACTOR },
    );
    await new Promise((r) => setTimeout(r, 100));
    const second = await req<{ error: { code: string } }>('POST', '/v1/retention/run', {
      institutionId,
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('retention_job_running');
    release();
    const done = await first;
    expect(done.body.status).toBe('completed');
    expect(done.body.kinds.audio).toMatchObject({ deleted: 1, skippedHold: 1 });

    const stored = await req<{ holdsApplied: string[]; kinds: { audio: { deleted: number } } }>(
      'GET',
      `/v1/retention/jobs/${done.body.id}`,
    );
    expect(stored.body.holdsApplied).toEqual([hold.body.id]);
    expect(stored.body.kinds.audio.deleted).toBe(1);

    target.gate = undefined;
    await req('DELETE', `/v1/legal-holds/${hold.body.id}`, { actorId: ACTOR });
    const again = await req<{ kinds: { audio: Record<string, number> } }>(
      'POST',
      '/v1/retention/run',
      {
        institutionId,
      },
    );
    expect(again.body.kinds.audio).toMatchObject({ deleted: 1, skippedHold: 0 });
    const jobs = await req<{ items: unknown[] }>(
      'GET',
      `/v1/retention/jobs?institutionId=${institutionId}`,
    );
    expect(jobs.body.items).toHaveLength(2);
    const holds = await req<{ items: { releasedAt?: string }[] }>(
      'GET',
      `/v1/legal-holds?institutionId=${institutionId}`,
    );
    expect(holds.body.items[0]?.releasedAt).toBeTruthy();
    expect(audit.events.filter((e) => e.action === 'retention.deleted')).toHaveLength(2);
  });
});
