import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { InMemoryTranscriptRepository } from '../repository.js';
import {
  EmbeddingUnavailableError,
  FakeEmbeddingClient,
  type EmbeddingClient,
} from './embeddings.js';

const SEC_A = '5aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SEC_B = '5bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REC_A = 'a0000000-0000-4000-8000-000000000001';
const REC_B = 'b0000000-0000-4000-8000-000000000002';
const SC_A = 'c0000000-0000-4000-8000-000000000003';

const texts = [
  'Bom dia, turma. Hoje vamos falar sobre a curva IS-LM.',
  'A curva IS representa o equilíbrio no mercado de bens.',
  'Já a curva LM mostra o equilíbrio no mercado monetário.',
  'Lembrem que a prova será no dia vinte de novembro.',
  'As avaliações valem trinta pontos no total.',
];

function transcript(
  rec: string,
  section: string | undefined,
  lines: string[],
  version = 'v1',
): Record<string, unknown> {
  return {
    recordingSessionId: rec,
    scheduledClassId: SC_A,
    ...(section ? { classSectionId: section } : {}),
    processingVersion: version,
    provider: 'google',
    model: 'chirp_2',
    segments: lines.map((text, i) => ({
      segmentIndex: i,
      startMs: i * 10_000,
      endMs: i * 10_000 + 9000,
      text,
      confidence: 0.9,
      speakerLabel: 'SPEAKER_1',
    })),
  };
}

type SearchBody = {
  results: {
    transcriptId: string;
    classSectionId: string;
    segmentIndex: number;
    highlight: string;
    score: number;
    speakerLabel?: string;
  }[];
  mode: string;
  degraded: boolean;
};

async function setup(embeddings: EmbeddingClient = new FakeEmbeddingClient()) {
  const app = buildApp({ repository: new InMemoryTranscriptRepository(), embeddings });
  const a = (
    await app.inject({
      method: 'POST',
      url: '/v1/transcripts',
      payload: transcript(REC_A, SEC_A, texts),
    })
  ).json<{ id: string }>();
  await app.inject({
    method: 'POST',
    url: '/v1/transcripts',
    payload: transcript(REC_B, SEC_B, [
      'A prova de anatomia será sexta-feira.',
      'Curva de aprendizagem.',
    ]),
  });
  return { app, transcriptA: a.id };
}

const search = async (app: ReturnType<typeof buildApp>, qs: string) =>
  app.inject({ url: `/v1/search?${qs}` });

describe('GET /v1/search (3.6)', () => {
  it('finds passages accent- and inflection-insensitively, only within the allowed sections', async () => {
    const { app, transcriptA } = await setup();
    const r = (
      await search(
        app,
        `q=${encodeURIComponent('avaliacao')}&classSectionIds=${SEC_A}&mode=lexical`,
      )
    ).json<SearchBody>();
    expect(r.results[0]).toMatchObject({
      transcriptId: transcriptA,
      segmentIndex: 4,
      classSectionId: SEC_A,
      speakerLabel: 'SPEAKER_1',
    });
    expect(r.results[0]?.highlight).toBe(
      'As <mark>avaliações</mark> valem trinta pontos no total.',
    );

    const prova = (await search(app, `q=prova&classSectionIds=${SEC_A}`)).json<SearchBody>();
    expect(prova.results.every((x) => x.classSectionId === SEC_A)).toBe(true);
    expect(prova.results[0]?.segmentIndex).toBe(3);

    const both = (
      await search(app, `q=prova&classSectionIds=${SEC_A},${SEC_B}`)
    ).json<SearchBody>();
    expect(new Set(both.results.map((x) => x.classSectionId))).toEqual(new Set([SEC_A, SEC_B]));

    const other = (await search(app, `q=equilibrio&classSectionIds=${SEC_B}`)).json<SearchBody>();
    expect(other.results).toHaveLength(0);
  });

  it('ranks with hybrid fusion and supports semantic mode', async () => {
    const { app } = await setup();
    const hybrid = (
      await search(
        app,
        `q=${encodeURIComponent('equilíbrio curva')}&classSectionIds=${SEC_A}&limit=2`,
      )
    ).json<SearchBody>();
    expect(hybrid.mode).toBe('hybrid');
    expect(hybrid.results).toHaveLength(2);
    expect(hybrid.results.map((x) => x.segmentIndex).sort()).toEqual([1, 2]);
    const semantic = (
      await search(
        app,
        `q=${encodeURIComponent('mercado monetário')}&classSectionIds=${SEC_A}&mode=semantic`,
      )
    ).json<SearchBody>();
    expect(semantic.results[0]?.segmentIndex).toBe(2);
  });

  it('requires classSectionIds and validates input', async () => {
    const { app } = await setup();
    expect((await search(app, 'q=prova')).statusCode).toBe(400);
    expect((await search(app, 'q=prova&classSectionIds=')).statusCode).toBe(400);
    expect((await search(app, 'q=prova&classSectionIds=not-a-uuid')).statusCode).toBe(400);
    expect((await search(app, `q=&classSectionIds=${SEC_A}`)).statusCode).toBe(400);
  });

  it('does not index transcripts without a class section and replaces superseded processing versions', async () => {
    const app = buildApp({ repository: new InMemoryTranscriptRepository() });
    await app.inject({
      method: 'POST',
      url: '/v1/transcripts',
      payload: transcript(REC_A, undefined, ['teorema de Pitágoras']),
    });
    expect(
      (await search(app, `q=teorema&classSectionIds=${SEC_A}`)).json<SearchBody>().results,
    ).toHaveLength(0);

    await app.inject({
      method: 'POST',
      url: '/v1/transcripts',
      payload: transcript(REC_B, SEC_A, ['teorema de Pitágoras'], 'v1'),
    });
    const v2 = (
      await app.inject({
        method: 'POST',
        url: '/v1/transcripts',
        payload: transcript(REC_B, SEC_A, ['teorema de Tales'], 'v2'),
      })
    ).json<{ id: string }>();
    const hits = (await search(app, `q=teorema&classSectionIds=${SEC_A}`)).json<SearchBody>()
      .results;
    expect(hits.map((h) => h.transcriptId)).toEqual([v2.id]);
  });

  it('degrades hybrid search to lexical when embeddings fail, and 502s in semantic mode', async () => {
    let fail = false;
    const fake = new FakeEmbeddingClient();
    const flaky: EmbeddingClient = {
      model: 'flaky',
      embed: (t) => (fail ? Promise.reject(new EmbeddingUnavailableError('down')) : fake.embed(t)),
    };
    const { app } = await setup(flaky);
    fail = true;
    const r = (await search(app, `q=prova&classSectionIds=${SEC_A}`)).json<SearchBody>();
    expect(r.degraded).toBe(true);
    expect(r.results[0]?.segmentIndex).toBe(3);
    expect((await search(app, `q=prova&classSectionIds=${SEC_A}&mode=semantic`)).statusCode).toBe(
      502,
    );
  });
});
