import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { AcademicUnavailableError, InMemoryAuditClient, StaticAcademicClient } from './clients.js';
import { InMemoryEventPublisher } from './events.js';
import { InMemoryTranscriptRepository } from './repository.js';

const INST = '11111111-1111-4111-8111-111111111111';
const SECTION = '55555555-5555-4555-8555-555555555555';
const SC = 'c0000000-0000-4000-8000-000000000003';
const REC = 'a0000000-0000-4000-8000-000000000001';
const PROF = '77777777-7777-4777-8777-777777777777';
const OTHER_PROF = '78888888-7777-4777-8777-777777777777';
const ADMIN = '99999999-9999-4999-8999-999999999999';

async function setup() {
  const academic = new StaticAcademicClient();
  academic.add({ id: SC, classSectionId: SECTION, professorId: PROF, institutionId: INST });
  const audit = new InMemoryAuditClient();
  const events = new InMemoryEventPublisher();
  const app = buildApp({ repository: new InMemoryTranscriptRepository(), academic, audit, events });
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
          { segmentIndex: 0, startMs: 0, endMs: 4000, text: 'Bom dia turma.', confidence: 0.95 },
          {
            segmentIndex: 1,
            startMs: 4000,
            endMs: 9000,
            text: 'A curva é ese ele eme.',
            confidence: 0.55,
            words: [{ word: 'A', startMs: 4000, endMs: 4100 }],
          },
        ],
      },
    })
  ).json<{ id: string }>();
  return { app, audit, events, academic, id: t.id };
}

const headers = (id: string, role: string) => ({ 'x-actor-id': id, 'x-actor-role': role });

describe('transcript corrections (2.18 / 2.19)', () => {
  it('versions corrections and preserves the original machine text', async () => {
    const { app, audit, events, id } = await setup();
    const url = `/v1/transcripts/${id}/segments/1/corrections`;
    const c1 = await app.inject({
      method: 'POST',
      url,
      headers: headers(PROF, 'professor'),
      payload: { correctedText: 'A curva é IS-LM.', reason: 'termo técnico' },
    });
    expect(c1.statusCode).toBe(201);
    expect(c1.json()).toMatchObject({
      correction: {
        version: 1,
        previousText: 'A curva é ese ele eme.',
        correctedBy: PROF,
        correctedByRole: 'professor',
      },
      segment: {
        text: 'A curva é IS-LM.',
        originalText: 'A curva é ese ele eme.',
        correctionStatus: 'corrected',
        version: 1,
      },
    });
    const c2 = await app.inject({
      method: 'POST',
      url,
      headers: headers(ADMIN, 'admin'),
      payload: { correctedText: 'A curva é a IS-LM.' },
    });
    expect(c2.json<{ correction: { version: number } }>().correction.version).toBe(2);

    const history = (await app.inject({ url })).json<{
      currentVersion: number;
      originalText: string;
      versions: { version: number; text: string; source: string }[];
    }>();
    expect(history.currentVersion).toBe(2);
    expect(history.versions.map((v) => [v.version, v.source])).toEqual([
      [0, 'machine'],
      [1, 'professor'],
      [2, 'admin'],
    ]);

    const latest = (await app.inject({ url: `/v1/transcripts/${id}?version=latest` })).json<{
      segments: { text: string }[];
      stats: { correctedSegmentCount: number };
    }>();
    expect(latest.segments[1]?.text).toBe('A curva é a IS-LM.');
    expect(latest.stats.correctedSegmentCount).toBe(1);
    const original = (await app.inject({ url: `/v1/transcripts/${id}?version=original` })).json<{
      segments: { text: string; correctionStatus: string; version: number }[];
    }>();
    expect(original.segments[1]).toMatchObject({
      text: 'A curva é ese ele eme.',
      correctionStatus: 'original',
      version: 0,
    });
    const segs = (
      await app.inject({ url: `/v1/transcripts/${id}/segments?version=original&includeWords=true` })
    ).json<{ items: { text: string; words: unknown[] }[] }>();
    expect(segs.items[1]?.text).toBe('A curva é ese ele eme.');
    expect(segs.items[1]?.words).toHaveLength(1);
    const txt = (await app.inject({ url: `/v1/transcripts/${id}/export.txt?version=original` }))
      .body;
    expect(txt).toContain('ese ele eme');

    expect(audit.events.map((e) => [e.action, e.actorId, e.tenantId])).toEqual([
      ['transcript.corrected', PROF, INST],
      ['transcript.corrected', ADMIN, INST],
    ]);
    expect(audit.events[0]?.metadata).toMatchObject({
      segmentIndex: 1,
      version: 1,
      recordingSessionId: REC,
    });
    expect(events.events[0]).toMatchObject({
      type: 'transcript.corrected',
      source: 'transcript-management',
      institutionId: INST,
      data: { transcriptId: id, segmentIndex: 1, version: 1 },
    });
    expect(
      (await app.inject({ url: `/v1/transcripts/${id}/corrections` })).json<{ items: unknown[] }>()
        .items,
    ).toHaveLength(2);

    // the corrected text is searchable; the machine mistake is not
    const s1 = (
      await app.inject({ url: `/v1/search?q=IS-LM&classSectionIds=${SECTION}&mode=lexical` })
    ).json<{ results: { segmentIndex: number }[] }>();
    expect(s1.results.map((r) => r.segmentIndex)).toEqual([1]);
    const s2 = (
      await app.inject({ url: `/v1/search?q=eme&classSectionIds=${SECTION}&mode=lexical` })
    ).json<{ results: unknown[] }>();
    expect(s2.results).toHaveLength(0);
  });

  it('enforces authorization', async () => {
    const { app, id, academic } = await setup();
    const url = `/v1/transcripts/${id}/segments/0/corrections`;
    const body = { correctedText: 'Bom dia, turma!' };
    expect((await app.inject({ method: 'POST', url, payload: body })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url, headers: headers(PROF, 'student'), payload: body }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: headers(OTHER_PROF, 'professor'),
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: headers(PROF, 'coordinator'),
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    const mismatch = await app.inject({
      method: 'POST',
      url,
      headers: headers(PROF, 'professor'),
      payload: { ...body, correctedBy: ADMIN },
    });
    expect(mismatch.json<{ error: { code: string } }>().error.code).toBe('actor_mismatch');

    academic.getScheduledClass = () => Promise.reject(new AcademicUnavailableError('down'));
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: headers(PROF, 'professor'),
          payload: body,
        })
      ).statusCode,
    ).toBe(502);
    // admins do not depend on academic-integration
    expect(
      (await app.inject({ method: 'POST', url, headers: headers(ADMIN, 'admin'), payload: body }))
        .statusCode,
    ).toBe(201);
  });

  it('validates corrections', async () => {
    const { app, id } = await setup();
    const h = headers(PROF, 'professor');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/transcripts/${id}/segments/0/corrections`,
          headers: h,
          payload: { correctedText: 'Bom dia turma.' },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/transcripts/${id}/segments/0/corrections`,
          headers: h,
          payload: { correctedText: '   ' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/transcripts/${id}/segments/9/corrections`,
          headers: h,
          payload: { correctedText: 'x' },
        })
      ).statusCode,
    ).toBe(404);
    expect((await app.inject({ url: `/v1/transcripts/${id}?version=v7` })).statusCode).toBe(400);
  });
});
