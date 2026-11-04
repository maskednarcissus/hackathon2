import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { InMemoryTranscriptRepository } from '../repository.js';
import { analyze, languageOf, stem } from './text.js';

describe('language-aware analysis (6.4)', () => {
  it('maps BCP-47 tags to analysers', () => {
    expect(
      ['pt-BR', 'en-US', 'es-419', 'es-ES', 'fr-FR', 'de-DE', undefined].map(languageOf),
    ).toEqual(['pt', 'en', 'es', 'es', 'fr', 'xx', 'pt']);
  });

  it('removes stopwords and conflates inflections per language', () => {
    expect(analyze('The students are studying the equations', 'en')).toEqual(
      analyze('student study equation', 'en'),
    );
    expect(stem('nations', 'en')).toBe(stem('nation', 'en'));
    expect(analyze('Las evaluaciones de los estudiantes', 'es')).toEqual(
      analyze('evaluación estudiante', 'es'),
    );
    expect(stem('universidades', 'es')).toBe(stem('universidad', 'es'));
    expect(analyze('Les équations différentielles', 'fr')).toEqual(
      analyze('équation différentielle', 'fr'),
    );
    expect(stem('journaux', 'fr')).toBe(stem('journal', 'fr'));
    // unknown languages: folding only
    expect(analyze('Die Prüfungen', 'xx')).toEqual(['die', 'prufungen']);
  });
});

describe('multilingual search', () => {
  const SEC = '5aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const body = (rec: string, language: string, text: string): Record<string, unknown> => ({
    recordingSessionId: rec,
    classSectionId: SEC,
    language,
    processingVersion: 'v1',
    provider: 'google',
    model: 'chirp_2',
    segments: [{ segmentIndex: 0, startMs: 0, endMs: 4000, text, confidence: 0.9 }],
  });

  it('analyses each transcript in its own language and reports it', async () => {
    const app = buildApp({ repository: new InMemoryTranscriptRepository() });
    await app.inject({
      method: 'POST',
      url: '/v1/transcripts',
      payload: body(
        'a0000000-0000-4000-8000-000000000001',
        'en-US',
        'The final examinations are scheduled for December.',
      ),
    });
    await app.inject({
      method: 'POST',
      url: '/v1/transcripts',
      payload: body(
        'a0000000-0000-4000-8000-000000000002',
        'es-419',
        'Los exámenes finales serán en diciembre.',
      ),
    });
    await app.inject({
      method: 'POST',
      url: '/v1/transcripts',
      payload: body(
        'a0000000-0000-4000-8000-000000000003',
        'pt-BR',
        'As provas finais serão em dezembro.',
      ),
    });
    const search = async (q: string) =>
      (
        await app.inject({
          url: `/v1/search?q=${encodeURIComponent(q)}&classSectionIds=${SEC}&mode=lexical`,
        })
      ).json<{ results: { language: string; highlight: string }[] }>().results;
    const en = await search('examination');
    expect(en.map((r) => r.language)).toEqual(['en-US']);
    expect(en[0]?.highlight).toContain('<mark>examinations</mark>');
    expect((await search('examen')).map((r) => r.language)).toEqual(['es-419']);
    expect((await search('prova')).map((r) => r.language)).toEqual(['pt-BR']);
    // "the"/"are" are English stopwords: they never match anything
    expect(await search('the are')).toEqual([]);
  });
});
