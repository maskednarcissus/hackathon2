import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { StaticAcademicClient } from './clients.js';
import { PgTranscriptRepository } from './repository.pg.js';
import { FakeEmbeddingClient } from './search/embeddings.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from './test/pg.js';
import { IDS, seedAcademicChain } from './test/seed.js';

const [REC1, REC2] = IDS.recordings;

function transcriptBody(rec: string, version: string, texts: string[]): Record<string, unknown> {
  return {
    recordingSessionId: rec,
    scheduledClassId: IDS.scheduledClass,
    classSectionId: IDS.section,
    institutionId: IDS.institution,
    processingVersion: version,
    provider: 'google',
    model: 'chirp_2',
    segments: texts.map((text, i) => ({
      segmentIndex: i,
      startMs: i * 5000,
      endMs: i * 5000 + 4500,
      text,
      confidence: 0.9 - (i % 3) * 0.1,
      speakerLabel: 'SPEAKER_1',
      words: [
        {
          word: text.split(' ')[0] ?? 'x',
          startMs: i * 5000,
          endMs: i * 5000 + 300,
          confidence: 0.9,
        },
      ],
    })),
  };
}

describe.skipIf(!TEST_DATABASE_URL)('transcript-management on Postgres', () => {
  let db: TestDatabase;
  let repo: PgTranscriptRepository;
  let app: ReturnType<typeof buildApp>;
  let id = '';

  beforeAll(async () => {
    db = await createTestDatabase(TEST_DATABASE_URL ?? '');
    await seedAcademicChain(db.pool);
    repo = new PgTranscriptRepository(db.pool);
    const academic = new StaticAcademicClient();
    academic.add({
      id: IDS.scheduledClass,
      classSectionId: IDS.section,
      professorId: IDS.professor,
      institutionId: IDS.institution,
    });
    app = buildApp({ repository: repo, vectorStore: repo, academic, warmSearchIndex: true });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('stores a long transcript with words, stats and speaker labels', async () => {
    const texts = Array.from({ length: 1200 }, (_, i) =>
      i === 7 ? 'A prova será no dia vinte de novembro.' : `frase número ${i}`,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/transcripts',
      payload: transcriptBody(REC1 ?? '', 'v1', texts),
    });
    expect(res.statusCode).toBe(201);
    id = res.json<{ id: string }>().id;
    const t = (await app.inject({ url: `/v1/transcripts/${id}` })).json<{
      stats: { segmentCount: number; durationMs: number };
      speakerCount: number;
    }>();
    expect(t.stats.segmentCount).toBe(1200);
    expect(t.speakerCount).toBe(1);
    const page = (
      await app.inject({
        url: `/v1/transcripts/${id}/segments?fromMs=30000&toMs=45000&includeWords=true`,
      })
    ).json<{ items: { segmentIndex: number; words: unknown[]; confidence: number }[] }>();
    expect(page.items.map((s) => s.segmentIndex)).toEqual([6, 7, 8]);
    expect(page.items[0]?.words).toHaveLength(1);
    expect(page.items[1]?.confidence).toBeCloseTo(0.8, 3);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/transcripts',
          payload: transcriptBody(REC1 ?? '', 'v1', ['x']),
        })
      ).statusCode,
    ).toBe(409);
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/transcripts',
      payload: transcriptBody('a9999999-0000-4000-8000-000000000009', 'v1', ['x']),
    });
    expect(unknown.statusCode).toBe(422);
  });

  it('applies speaker labels and versioned corrections with the original preserved', async () => {
    const speakers = await app.inject({
      method: 'PUT',
      url: `/v1/transcripts/${id}/speakers`,
      payload: {
        speakerCount: 2,
        method: 'provider_tags',
        processingVersion: 'diar-1',
        assignments: [{ segmentIndex: 7, speakerLabel: 'SPEAKER_2' }],
      },
    });
    expect(speakers.json()).toMatchObject({
      speakerCount: 2,
      diarizationMethod: 'provider_tags',
      diarizationVersion: 'diar-1',
    });
    expect((await app.inject({ url: `/v1/transcripts/${id}` })).json()).toMatchObject({
      diarizationMethod: 'provider_tags',
      diarizationVersion: 'diar-1',
    });
    const h = { 'x-actor-id': IDS.professor, 'x-actor-role': 'professor' };
    const url = `/v1/transcripts/${id}/segments/7/corrections`;
    const c1 = await app.inject({
      method: 'POST',
      url,
      headers: h,
      payload: { correctedText: 'A prova será no dia 20 de novembro.', reason: 'data' },
    });
    expect(c1.statusCode).toBe(201);
    const c2 = await app.inject({
      method: 'POST',
      url,
      headers: h,
      payload: { correctedText: 'A segunda prova será no dia 20 de novembro.' },
    });
    expect(c2.json<{ correction: { version: number } }>().correction.version).toBe(2);
    const history = (await app.inject({ url })).json<{
      currentVersion: number;
      versions: { version: number; text: string }[];
    }>();
    expect(history.currentVersion).toBe(2);
    expect(history.versions.map((v) => v.version)).toEqual([0, 1, 2]);
    const original = (
      await app.inject({
        url: `/v1/transcripts/${id}/segments?version=original&fromMs=35000&toMs=36000`,
      })
    ).json<{ items: { text: string; speakerLabel: string }[] }>();
    expect(original.items[0]).toMatchObject({
      text: 'A prova será no dia vinte de novembro.',
      speakerLabel: 'SPEAKER_2',
    });
    await expect(
      db.pool.query("UPDATE transcript_segments SET original_text = 'x' WHERE segment_index = 7"),
    ).rejects.toThrow(/immutable/);
  });

  it('serialises concurrent corrections (one wins, the other conflicts)', async () => {
    const h = { 'x-actor-id': IDS.professor, 'x-actor-role': 'professor' };
    const url = `/v1/transcripts/${id}/segments/3/corrections`;
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url, headers: h, payload: { correctedText: 'versão A' } }),
      app.inject({ method: 'POST', url, headers: h, payload: { correctedText: 'versão B' } }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
  });

  it('persists embeddings and rebuilds the search index on restart', async () => {
    const hits = (
      await app.inject({ url: `/v1/search?q=segunda prova&classSectionIds=${IDS.section}` })
    ).json<{ results: { segmentIndex: number }[] }>();
    expect(hits.results[0]?.segmentIndex).toBe(7);
    const stored = await db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM segment_embeddings',
    );
    expect(stored.rows[0]?.n).toBe(1200);

    let embedCalls = 0;
    const counting = new FakeEmbeddingClient();
    const spy = {
      model: counting.model,
      embed: (texts: string[]) => {
        embedCalls += texts.length;
        return counting.embed(texts);
      },
    };
    const restarted = buildApp({
      repository: repo,
      vectorStore: repo,
      embeddings: spy,
      warmSearchIndex: true,
    });
    await restarted.ready();
    expect(embedCalls).toBe(0); // vectors loaded from segment_embeddings
    const again = (
      await restarted.inject({
        url: `/v1/search?q=segunda prova&classSectionIds=${IDS.section}&mode=semantic`,
      })
    ).json<{ results: { segmentIndex: number }[] }>();
    expect(again.results[0]?.segmentIndex).toBe(7);
    await restarted.close();
  });

  it('supersedes older processing versions in the index', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/transcripts',
      payload: transcriptBody(REC2 ?? '', 'v1', ['teorema de Pitágoras']),
    });
    const v2 = (
      await app.inject({
        method: 'POST',
        url: '/v1/transcripts',
        payload: transcriptBody(REC2 ?? '', 'v2', ['teorema de Tales']),
      })
    ).json<{ id: string }>();
    const restarted = buildApp({ repository: repo, vectorStore: repo, warmSearchIndex: true });
    await restarted.ready();
    const hits = (
      await restarted.inject({ url: `/v1/search?q=teorema&classSectionIds=${IDS.section}` })
    ).json<{ results: { transcriptId: string }[] }>();
    expect(hits.results.map((r) => r.transcriptId)).toEqual([v2.id]);
    await restarted.close();
  });

  it('serves retention and DSR against Postgres', async () => {
    const candidates = (
      await app.inject({
        url: `/internal/v1/retention/candidates?institutionId=${IDS.institution}&olderThan=2100-01-01T00:00:00Z&kind=transcript`,
      })
    ).json<{ candidates: { id: string; subjectIds?: string[] }[] }>();
    expect(candidates.candidates).toHaveLength(3);
    expect(candidates.candidates.find((c) => c.id === id)?.subjectIds).toEqual([IDS.professor]);

    const payload = {
      subjectType: 'professor',
      subjectId: IDS.professor,
      requestId: REC1,
      institutionId: IDS.institution,
    };
    const access = (
      await app.inject({ method: 'POST', url: '/internal/v1/dsr/access', payload })
    ).json<{ items: { corrections: unknown[] } }>();
    expect(access.items.corrections).toHaveLength(3);
    const anon = (
      await app.inject({ method: 'POST', url: '/internal/v1/dsr/anonymization', payload })
    ).json<{ items: { correctionsAnonymised: number } }>();
    expect(anon.items.correctionsAnonymised).toBe(3);

    const del = (
      await app.inject({
        method: 'POST',
        url: '/internal/v1/retention/delete',
        payload: { ids: [id], kind: 'transcript', jobId: 'job-1' },
      })
    ).json<{ deletedIds: string[] }>();
    expect(del.deletedIds).toEqual([id]);
    const left = await db.pool.query<{ s: number; c: number; e: number }>(
      `SELECT (SELECT count(*) FROM transcript_segments WHERE transcript_id = $1)::int AS s,
              (SELECT count(*) FROM transcript_corrections WHERE transcript_id = $1)::int AS c,
              (SELECT count(*) FROM segment_embeddings e JOIN transcript_segments s ON s.id = e.transcript_segment_id WHERE s.transcript_id = $1)::int AS e`,
      [id],
    );
    expect(left.rows[0]).toEqual({ s: 0, c: 0, e: 0 });
    expect(
      (
        await app.inject({
          url: `/v1/search?q=segunda prova&classSectionIds=${IDS.section}&mode=lexical`,
        })
      ).json<{ results: unknown[] }>().results,
    ).toHaveLength(0);
  });
});
