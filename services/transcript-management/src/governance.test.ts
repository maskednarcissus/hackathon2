import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { InMemoryAuditClient, StaticAcademicClient } from './clients.js';
import { InMemoryTranscriptRepository } from './repository.js';
import { token, verifier } from './test/tokens.js';

const INST = '11111111-1111-4111-8111-111111111111';
const SECTION = '55555555-5555-4555-8555-555555555555';
const SECTION_B = '56555555-5555-4555-8555-555555555555';
const SC = 'c0000000-0000-4000-8000-000000000003';
const REC = 'a0000000-0000-4000-8000-000000000001';
const PROF = '77777777-7777-4777-8777-777777777777';
const STUDENT = '66666666-6666-4666-8666-666666666666';
const TOKEN = 'internal-secret';

async function setup(clockIso = '2026-11-04T12:00:00.000Z') {
  const academic = new StaticAcademicClient();
  academic.add({ id: SC, classSectionId: SECTION, professorId: PROF, institutionId: INST });
  const audit = new InMemoryAuditClient();
  const repo = new InMemoryTranscriptRepository();
  const app = buildApp({
    repository: repo,
    academic,
    audit,
    internalToken: TOKEN,
    verifier,
    clock: { now: () => new Date(clockIso) },
  });
  const t = (
    await app.inject({
      method: 'POST',
      url: '/v1/transcripts',
      payload: {
        recordingSessionId: REC,
        scheduledClassId: SC,
        classSectionId: SECTION,
        institutionId: INST,
        processingVersion: 'v1',
        provider: 'google',
        model: 'chirp_2',
        segments: [
          {
            segmentIndex: 0,
            startMs: 0,
            endMs: 4000,
            text: 'A prova será no dia vinte.',
            confidence: 0.95,
          },
          {
            segmentIndex: 1,
            startMs: 4000,
            endMs: 9000,
            text: 'A curva é ese ele eme.',
            confidence: 0.55,
          },
        ],
      },
    })
  ).json<{ id: string }>();
  const correct = await app.inject({
    method: 'POST',
    url: `/v1/transcripts/${t.id}/segments/1/corrections`,
    headers: { 'x-actor-id': PROF, 'x-actor-role': 'professor' },
    payload: { correctedText: 'A curva é IS-LM.' },
  });
  if (correct.statusCode !== 201) throw new Error(correct.body);
  return { app, audit, repo, id: t.id };
}

const internal = { 'x-internal-token': TOKEN };

describe('retention kind transcript (integration-stage §5)', () => {
  it('lists candidates older than the cut-off and deletes them (removing them from search)', async () => {
    const { app, id } = await setup();
    const none = await app.inject({
      url: `/internal/v1/retention/candidates?institutionId=${INST}&olderThan=2026-11-01T00:00:00Z&kind=transcript`,
      headers: internal,
    });
    expect(none.json()).toEqual({ candidates: [] });
    const res = await app.inject({
      url: `/internal/v1/retention/candidates?institutionId=${INST}&olderThan=2026-11-05T00:00:00Z&kind=transcript`,
      headers: internal,
    });
    expect(res.json()).toEqual({
      candidates: [
        {
          id,
          createdAt: '2026-11-04T12:00:00.000Z',
          recordingSessionId: REC,
          classSectionId: SECTION,
          subjectIds: [PROF],
        },
      ],
    });
    expect(
      (
        await app.inject({
          url: `/internal/v1/retention/candidates?institutionId=${INST}&olderThan=2026-11-05T00:00:00Z&kind=audio`,
          headers: internal,
        })
      ).statusCode,
    ).toBe(400);

    expect(
      (await app.inject({ url: `/v1/search?q=prova&classSectionIds=${SECTION}` })).json<{
        results: unknown[];
      }>().results,
    ).toHaveLength(1);
    const del = await app.inject({
      method: 'POST',
      url: '/internal/v1/retention/delete',
      headers: internal,
      payload: { ids: [id, REC], kind: 'transcript', jobId: 'job-1' },
    });
    expect(del.json()).toEqual({ deletedIds: [id] });
    expect((await app.inject({ url: `/v1/transcripts/${id}` })).statusCode).toBe(404);
    expect(
      (await app.inject({ url: `/v1/search?q=prova&classSectionIds=${SECTION}` })).json<{
        results: unknown[];
      }>().results,
    ).toHaveLength(0);
  });

  it('requires the internal token', async () => {
    const { app } = await setup();
    const r = await app.inject({
      url: `/internal/v1/retention/candidates?institutionId=${INST}&olderThan=2026-11-05T00:00:00Z&kind=transcript`,
    });
    expect(r.statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/internal/v1/dsr/access', payload: {} }))
        .statusCode,
    ).toBe(401);
  });
});

describe('DSR handler (integration-stage §5)', () => {
  const payload = (subjectType: string, subjectId: string) => ({
    subjectType,
    subjectId,
    requestId: REC,
    institutionId: INST,
  });

  it('exports and anonymises corrections authored by a professor', async () => {
    const { app, id } = await setup();
    const access = await app.inject({
      method: 'POST',
      url: '/internal/v1/dsr/access',
      headers: internal,
      payload: payload('professor', PROF),
    });
    expect(access.json()).toMatchObject({
      service: 'transcript-management',
      status: 'completed',
      items: {
        corrections: [{ transcriptId: id, correctedBy: PROF, correctedText: 'A curva é IS-LM.' }],
      },
    });
    const del = await app.inject({
      method: 'POST',
      url: '/internal/v1/dsr/deletion',
      headers: internal,
      payload: payload('professor', PROF),
    });
    expect(del.json()).toMatchObject({ status: 'completed', items: { correctionsAnonymised: 1 } });
    const history = (await app.inject({ url: `/v1/transcripts/${id}/corrections` })).json<{
      items: { correctedBy: string; correctedText: string }[];
    }>();
    expect(history.items[0]).toMatchObject({
      correctedBy: '00000000-0000-0000-0000-000000000000',
      correctedText: 'A curva é IS-LM.',
    });
    // lecture content is unaffected
    const seg = (await app.inject({ url: `/v1/transcripts/${id}/segments` })).json<{
      items: { text: string }[];
    }>();
    expect(seg.items[1]?.text).toBe('A curva é IS-LM.');
  });

  it('answers not_applicable for students', async () => {
    const { app } = await setup();
    const r = await app.inject({
      method: 'POST',
      url: '/internal/v1/dsr/deletion',
      headers: internal,
      payload: payload('student', STUDENT),
    });
    expect(r.json()).toMatchObject({ status: 'not_applicable' });
  });
});

describe('lecture.searched engagement (integration-stage §5)', () => {
  it('audits student searches per section without storing the query', async () => {
    const { app, audit } = await setup();
    const bearer = {
      authorization: `Bearer ${token({ role: 'student', inst: INST, sub: 'user-1', pid: STUDENT })}`,
    };
    const r = await app.inject({
      url: `/v1/search?q=prova&classSectionIds=${SECTION},${SECTION_B}`,
      headers: bearer,
    });
    expect(r.statusCode).toBe(200);
    const searched = audit.events.filter((e) => e.action === 'lecture.searched');
    expect(searched).toEqual([
      {
        tenantId: INST,
        actorId: STUDENT,
        actorType: 'student',
        action: 'lecture.searched',
        resourceType: 'class_section',
        resourceId: SECTION,
        metadata: { classSectionId: SECTION, mode: 'hybrid', resultCount: 1 },
      },
      {
        tenantId: INST,
        actorId: STUDENT,
        actorType: 'student',
        action: 'lecture.searched',
        resourceType: 'class_section',
        resourceId: SECTION_B,
        metadata: { classSectionId: SECTION_B, mode: 'hybrid', resultCount: 0 },
      },
    ]);
    expect(JSON.stringify(searched)).not.toContain('prova');
  });

  it('does not audit anonymous or staff searches and rejects invalid tokens', async () => {
    const { app, audit } = await setup();
    await app.inject({ url: `/v1/search?q=prova&classSectionIds=${SECTION}` });
    await app.inject({
      url: `/v1/search?q=prova&classSectionIds=${SECTION}`,
      headers: { authorization: `Bearer ${token({ role: 'professor', inst: INST, sub: PROF })}` },
    });
    expect(audit.events.filter((e) => e.action === 'lecture.searched')).toHaveLength(0);
    expect(
      (
        await app.inject({
          url: `/v1/search?q=prova&classSectionIds=${SECTION}`,
          headers: { authorization: 'Bearer junk' },
        })
      ).statusCode,
    ).toBe(401);
  });
});
