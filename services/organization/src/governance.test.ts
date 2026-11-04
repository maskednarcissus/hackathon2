import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import {
  InMemoryAuditClient,
  StaticRosterClient,
  type RetentionCandidate,
  type RetentionTarget,
} from './clients.js';
import type { RetentionKind } from './domain.js';

const ACTOR = '99999999-0000-4000-8000-000000000001';
const PROF = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const S1 = 'bbbbbbbb-0000-4000-8000-0000000000b1';
const S2 = 'bbbbbbbb-0000-4000-8000-0000000000b2';
const SECTION = 'cccccccc-0000-4000-8000-0000000000c1';
const OTHER_SECTION = 'cccccccc-0000-4000-8000-0000000000c2';

class FakeTarget implements RetentionTarget {
  readonly deleteCalls: { ids: string[]; kind: RetentionKind; jobId: string }[] = [];
  readonly queries: { olderThan: string; kind: RetentionKind }[] = [];
  failCandidates = false;
  /** Ids the owner refuses to delete (reported as failures). */
  refuse = new Set<string>();
  constructor(
    readonly name: string,
    readonly kinds: readonly RetentionKind[],
    public items: (RetentionCandidate & { createdAt: string })[] = [],
  ) {}
  candidates(q: {
    institutionId: string;
    olderThan: string;
    kind: RetentionKind;
  }): Promise<RetentionCandidate[]> {
    this.queries.push({ olderThan: q.olderThan, kind: q.kind });
    if (this.failCandidates) return Promise.reject(new Error('owner unavailable'));
    return Promise.resolve(this.items.filter((i) => i.createdAt <= q.olderThan));
  }
  delete(r: { ids: string[]; kind: RetentionKind; jobId: string }): Promise<string[]> {
    this.deleteCalls.push(r);
    const deleted = r.ids.filter((id) => !this.refuse.has(id));
    this.items = this.items.filter((i) => !deleted.includes(i.id));
    return Promise.resolve(deleted);
  }
}

let app: FastifyInstance;
let audit: InMemoryAuditClient;
let roster: StaticRosterClient;
let audio: FakeTarget;
let transcripts: FakeTarget;
let clock: { current: Date; now(): Date };
let institutionId: string;
let classroomId: string;

async function req<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

type Policy = { id: string; currentVersion: number; currentVersionId: string };

beforeEach(async () => {
  audit = new InMemoryAuditClient();
  clock = {
    current: new Date('2026-11-04T12:00:00.000Z'),
    now(): Date {
      return new Date(this.current);
    },
  };
  audio = new FakeTarget('audio-ingestion', ['audio']);
  transcripts = new FakeTarget('transcript-management', ['transcript']);
  roster = new StaticRosterClient();
  app = buildApp({ deps: { audit, roster, clock, retentionTargets: [audio, transcripts] } });
  const h = await req('POST', '/v1/holding-companies', { name: 'G', legalName: 'G S.A.' });
  const i = await req('POST', '/v1/institutions', {
    holdingCompanyId: h.body['id'],
    name: 'U',
    state: 'SP',
  });
  institutionId = i.body['id'] as string;
  const c = await req('POST', '/v1/campuses', { institutionId, name: 'C', city: 'X', state: 'SP' });
  const r = await req('POST', '/v1/classrooms', { campusId: c.body['id'], name: 'S', code: 'R1' });
  classroomId = r.body['id'] as string;
  roster.rosters.set(SECTION, {
    classSectionId: SECTION,
    institutionId,
    professorIds: [PROF],
    studentIds: [S1, S2],
  });
});

const createPolicy = async (extra: Record<string, unknown> = {}): Promise<Policy> =>
  (
    await req<Policy>('POST', `/v1/institutions/${institutionId}/recording-policies`, {
      name: 'Padrão',
      legalBasis: 'consent',
      actorId: ACTOR,
      ...extra,
    })
  ).body;

describe('policy versions (4.10)', () => {
  it('creates version 1 on create and an immutable new version per content change', async () => {
    const policy = await createPolicy();
    expect(policy.currentVersion).toBe(1);

    const p2 = await req<Policy>('PATCH', `/v1/recording-policies/${policy.id}`, {
      audioRetentionDays: 30,
      changeReason: 'Comitê LGPD reduziu retenção',
      actorId: ACTOR,
    });
    expect(p2.body.currentVersion).toBe(2);

    // Non-content change (default flag) and no-op patches do not create versions.
    await req('PATCH', `/v1/recording-policies/${policy.id}`, { audioRetentionDays: 30 });
    const versions = await req<{
      items: {
        version: number;
        changedFields: string[];
        content: { audioRetentionDays: number };
      }[];
    }>('GET', `/v1/recording-policies/${policy.id}/versions`);
    expect(versions.body.items.map((v) => v.version)).toEqual([2, 1]);
    expect(versions.body.items[0]?.changedFields).toEqual(['audioRetentionDays']);
    expect(versions.body.items[1]?.content.audioRetentionDays).toBe(90);

    const v1 = await req<{ content: { audioRetentionDays: number }; changeReason: string }>(
      'GET',
      `/v1/recording-policies/${policy.id}/versions/1`,
    );
    expect(v1.body.content.audioRetentionDays).toBe(90);
    expect((await req('GET', `/v1/recording-policies/${policy.id}/versions/9`)).status).toBe(404);
    expect(
      audit.events.filter((e) => e.action === 'recording_policy.version_created'),
    ).toHaveLength(2);
  });

  it('reports the version in force on classroom resolution', async () => {
    const policy = await createPolicy();
    await req('PATCH', `/v1/recording-policies/${policy.id}`, { postRollMinutes: 9 });
    const res = await req('GET', `/v1/classrooms/${classroomId}/recording-policy`);
    expect(res.body).toMatchObject({ policyVersion: 2 });
    expect(typeof res.body['policyVersionId']).toBe('string');
  });
});

describe('consent (4.10)', () => {
  const consent = (
    policyId: string,
    subjectId: string,
    subjectType: 'student' | 'professor',
    given = true,
    classSectionId?: string,
  ): Promise<{ status: number; body: { id: string; policyVersion: number } }> =>
    req('POST', '/v1/consents', {
      subjectType,
      subjectId,
      policyId,
      given,
      actorId: subjectId,
      ...(classSectionId ? { classSectionId } : {}),
    });

  it('requires every professor and student when the policy requires explicit consent', async () => {
    const policy = await createPolicy({ requiresExplicitConsent: true });
    const status = async (): Promise<Record<string, unknown>> =>
      (await req('GET', `/v1/class-sections/${SECTION}/consent-status`)).body;

    expect(await status()).toMatchObject({
      requiresExplicitConsent: true,
      allProfessorsConsented: false,
      studentsConsented: 0,
      studentsTotal: 2,
      recordingAllowed: false,
      reason: 'consent_missing',
    });

    await consent(policy.id, PROF, 'professor');
    await consent(policy.id, S1, 'student');
    const s2 = await consent(policy.id, S2, 'student', true, SECTION);
    expect(s2.status).toBe(201);
    expect(s2.body.policyVersion).toBe(1);
    expect(await status()).toMatchObject({
      allProfessorsConsented: true,
      studentsConsented: 2,
      recordingAllowed: true,
      consentSatisfied: true,
    });

    const withdrawn = await req('POST', `/v1/consents/${s2.body.id}/withdraw`, {
      actorId: S2,
      reason: 'mudei de ideia',
    });
    expect(withdrawn.status).toBe(200);
    expect(await status()).toMatchObject({
      studentsConsented: 1,
      studentsDeclined: 1,
      recordingAllowed: false,
    });
    expect((await req('POST', `/v1/consents/${s2.body.id}/withdraw`, { actorId: S2 })).status).toBe(
      409,
    );
    expect(audit.events.map((e) => e.action)).toContain('consent.withdrawn');
  });

  it('section-specific decisions override policy-wide ones and new decisions supersede old', async () => {
    const policy = await createPolicy({ requiresExplicitConsent: true });
    await consent(policy.id, PROF, 'professor');
    await consent(policy.id, S1, 'student');
    await consent(policy.id, S2, 'student');
    // S1 refuses specifically for this section.
    await consent(policy.id, S1, 'student', false, SECTION);
    let s = (await req('GET', `/v1/class-sections/${SECTION}/consent-status`)).body;
    expect(s).toMatchObject({ studentsConsented: 1, recordingAllowed: false });

    // S1 changes mind: the newer section decision supersedes the refusal.
    await consent(policy.id, S1, 'student', true, SECTION);
    s = (await req('GET', `/v1/class-sections/${SECTION}/consent-status`)).body;
    expect(s).toMatchObject({ studentsConsented: 2, recordingAllowed: true });

    const current = await req<{ items: unknown[] }>('GET', `/v1/consents?subjectId=${S1}`);
    const all = await req<{ items: unknown[] }>(
      'GET',
      `/v1/consents?subjectId=${S1}&includeHistory=true`,
    );
    expect(current.body.items).toHaveLength(2);
    expect(all.body.items).toHaveLength(3);
  });

  it('exposes consentSatisfied on classroom policy resolution with ?classSectionId=', async () => {
    const policy = await createPolicy({ requiresExplicitConsent: true });
    const url = `/v1/classrooms/${classroomId}/recording-policy?classSectionId=${SECTION}`;
    expect((await req('GET', url)).body).toMatchObject({
      consentSatisfied: false,
      classSectionId: SECTION,
    });
    await consent(policy.id, PROF, 'professor');
    await consent(policy.id, S1, 'student');
    await consent(policy.id, S2, 'student');
    expect((await req('GET', url)).body).toMatchObject({ consentSatisfied: true });
  });

  it('does not consult the roster when consent is not required', async () => {
    await createPolicy({ requiresExplicitConsent: false });
    const res = await req(
      'GET',
      `/v1/classrooms/${classroomId}/recording-policy?classSectionId=${OTHER_SECTION}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ consentSatisfied: true });
    // The explicit status endpoint does need the roster.
    expect((await req('GET', `/v1/class-sections/${OTHER_SECTION}/consent-status`)).status).toBe(
      404,
    );
  });

  it('validates queries and unknown policies', async () => {
    expect((await req('GET', '/v1/consents')).status).toBe(400);
    const res = await consent('dddddddd-0000-4000-8000-000000000000', S1, 'student');
    expect(res.status).toBe(404);
  });
});

describe('legal holds & retention (4.12)', () => {
  const day = 86_400_000;
  const ago = (days: number): string =>
    new Date(clock.current.getTime() - days * day).toISOString();

  it('deletes due items, skips held ones and audits each decision', async () => {
    await createPolicy({ audioRetentionDays: 90, transcriptRetentionDays: 365 });
    const recHeld = 'eeeeeeee-0000-4000-8000-000000000001';
    audio.items = [
      { id: 'eeeeeeee-0000-4000-8000-0000000000a1', createdAt: ago(100), classSectionId: SECTION },
      {
        id: 'eeeeeeee-0000-4000-8000-0000000000a2',
        createdAt: ago(120),
        classSectionId: OTHER_SECTION,
      },
      { id: recHeld, createdAt: ago(200) },
      { id: 'eeeeeeee-0000-4000-8000-0000000000a3', createdAt: ago(10) },
    ];
    transcripts.items = [
      { id: 't-old', createdAt: ago(400), subjectIds: [S1] },
      { id: 't-young', createdAt: ago(200) },
    ];

    const hold1 = await req<{ id: string }>('POST', '/v1/legal-holds', {
      institutionId,
      scope: { type: 'class_section', id: SECTION },
      reason: 'Processo judicial 123',
      actorId: ACTOR,
    });
    await req('POST', '/v1/legal-holds', {
      institutionId,
      scope: { type: 'recording', id: recHeld },
      reason: 'Investigação interna',
      actorId: ACTOR,
    });
    expect(hold1.status).toBe(201);

    const dry = await req<Record<string, unknown>>('POST', '/v1/retention/run', {
      institutionId,
      dryRun: true,
    });
    expect(dry.status).toBe(201);
    expect(dry.body['kinds']).toMatchObject({
      audio: { candidates: 3, due: 3, wouldDelete: 1, skippedHold: 2, deleted: 0 },
      transcript: { candidates: 1, due: 1, wouldDelete: 1 },
    });
    expect(audio.deleteCalls).toHaveLength(0);
    expect(audit.events.filter((e) => e.action === 'retention.deleted')).toHaveLength(0);

    const run = await req<{
      id: string;
      status: string;
      kinds: Record<string, Record<string, number>>;
      holdsApplied: string[];
      unconfiguredKinds: string[];
    }>('POST', '/v1/retention/run', { institutionId, actorId: ACTOR });
    expect(run.body.status).toBe('completed');
    expect(run.body.kinds['audio']).toMatchObject({ deleted: 1, skippedHold: 2, failed: 0 });
    expect(run.body.kinds['transcript']).toMatchObject({ deleted: 1 });
    expect(run.body.holdsApplied).toHaveLength(2);
    expect(run.body.unconfiguredKinds).toEqual(['summary', 'extracted_event']);
    expect(audio.deleteCalls[0]).toMatchObject({
      ids: ['eeeeeeee-0000-4000-8000-0000000000a2'],
      kind: 'audio',
      jobId: run.body.id,
    });
    expect(audit.events.filter((e) => e.action === 'retention.deleted')).toHaveLength(2);
    expect(audit.events.filter((e) => e.action === 'retention.skipped_hold')).toHaveLength(2);

    // Releasing the section hold lets the next run delete that recording.
    await req('DELETE', `/v1/legal-holds/${hold1.body.id}`, {
      actorId: ACTOR,
      reason: 'encerrado',
    });
    clock.current = new Date(clock.current.getTime() + 1000);
    const after = await req<{ kinds: Record<string, Record<string, number>> }>(
      'POST',
      '/v1/retention/run',
      { institutionId },
    );
    expect(after.body.kinds['audio']).toMatchObject({ deleted: 1, skippedHold: 1 });

    const active = await req<{ items: unknown[] }>(
      'GET',
      `/v1/legal-holds?institutionId=${institutionId}&active=true`,
    );
    expect(active.body.items).toHaveLength(1);

    const jobs = await req<{ items: { id: string }[] }>(
      'GET',
      `/v1/retention/jobs?institutionId=${institutionId}`,
    );
    expect(jobs.body.items).toHaveLength(3);
    expect((await req('GET', `/v1/retention/jobs/${run.body.id}`)).body).toMatchObject({
      id: run.body.id,
    });
  });

  it('respects per-item policies and subject holds', async () => {
    const def = await createPolicy({ audioRetentionDays: 90 });
    const longer = await createPolicy({ name: 'Longa', audioRetentionDays: 365 });
    audio.items = [
      { id: 'a-default', createdAt: ago(100), recordingPolicyId: def.id },
      { id: 'a-longer', createdAt: ago(100), recordingPolicyId: longer.id },
      { id: 'a-subject', createdAt: ago(100), subjectIds: [S2] },
    ];
    await req('POST', '/v1/legal-holds', {
      institutionId,
      scope: { type: 'subject', id: S2 },
      reason: 'Solicitação do titular',
      actorId: ACTOR,
    });
    const run = await req<{ kinds: Record<string, Record<string, number>> }>(
      'POST',
      '/v1/retention/run',
      { institutionId },
    );
    expect(run.body.kinds['audio']).toMatchObject({
      candidates: 3,
      due: 2,
      deleted: 1,
      skippedHold: 1,
    });
    expect(audio.items.map((i) => i.id).sort()).toEqual(['a-longer', 'a-subject']);
  });

  it('records owner failures and partial deletions without failing the job', async () => {
    await createPolicy();
    audio.items = [
      { id: 'x1', createdAt: ago(100) },
      { id: 'x2', createdAt: ago(100) },
    ];
    audio.refuse.add('x2');
    transcripts.failCandidates = true;
    const run = await req<{
      status: string;
      kinds: Record<string, Record<string, number>>;
      errors: { kind: string; target: string }[];
    }>('POST', '/v1/retention/run', { institutionId });
    expect(run.body.status).toBe('completed_with_errors');
    expect(run.body.kinds['audio']).toMatchObject({ deleted: 1, failed: 1 });
    expect(run.body.errors).toEqual([
      expect.objectContaining({ kind: 'transcript', target: 'transcript-management' }),
    ]);
  });

  it('refuses future reference times and institutions without a default policy', async () => {
    expect((await req('POST', '/v1/retention/run', { institutionId })).status).toBe(422);
    await createPolicy();
    const future = new Date(clock.current.getTime() + 2 * day).toISOString();
    expect((await req('POST', '/v1/retention/run', { institutionId, now: future })).status).toBe(
      400,
    );
    expect(
      (await req('POST', '/v1/retention/run', { institutionId, now: future, dryRun: true })).status,
    ).toBe(201);
  });

  it('validates legal holds', async () => {
    const bad = await req('POST', '/v1/legal-holds', {
      institutionId,
      scope: { type: 'planet', id: SECTION },
      reason: 'x',
      actorId: ACTOR,
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await req('DELETE', '/v1/legal-holds/ffffffff-0000-4000-8000-000000000000', {
          actorId: ACTOR,
        })
      ).status,
    ).toBe(404);
  });
});
