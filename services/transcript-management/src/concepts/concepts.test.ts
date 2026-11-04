import { describe, expect, it } from 'vitest';
import { COURSE, envelope, OTHER, SEC_A, SEC_B, setupConcepts } from '../test/concepts.js';
import { applyLecture, normalizedKey } from './graph.js';

describe('concept graph builder', () => {
  it('merges by normalised term and recomputes edges', () => {
    expect(normalizedKey('Curvas LM', 'pt-BR')).toBe(normalizedKey('curva lm', 'pt-BR'));
    let id = 0;
    const newId = () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`;
    const base = {
      transcriptId: 't',
      lectureSummaryId: 'l',
      classSectionId: SEC_A,
      courseId: COURSE,
      institutionId: null,
      language: 'pt-BR',
      startsAt: null,
    };
    const u1 = applyLecture(
      { nodes: [], mentions: [] },
      {
        ...base,
        scheduledClassId: 's1',
        concepts: [
          { term: 'Curva LM', definition: 'x', example: null, segmentIndexes: [1], vector: null },
          {
            term: 'Juros',
            definition: 'preço da curva LM',
            example: null,
            segmentIndexes: [2],
            vector: null,
          },
        ],
      },
      'now',
      newId,
    );
    expect(u1.upsertNodes).toHaveLength(2);
    expect(u1.edges.map((e) => e.kind).sort()).toEqual(['co_occurrence', 'related']);
    const u2 = applyLecture(
      { nodes: u1.upsertNodes, mentions: u1.lectureMentions },
      {
        ...base,
        scheduledClassId: 's2',
        concepts: [
          { term: 'curvas LM', definition: 'y', example: null, segmentIndexes: [0], vector: null },
        ],
      },
      'now',
      newId,
    );
    expect(u2.upsertNodes.map((n) => n.aliases)).toEqual([['Curva LM', 'curvas LM']]);
    // re-applying lecture s1 without concepts removes its mentions and the orphan node
    const u3 = applyLecture(
      { nodes: u1.upsertNodes, mentions: [...u1.lectureMentions, ...u2.lectureMentions] },
      { ...base, scheduledClassId: 's1', concepts: [] },
      'now',
      newId,
    );
    expect(u3.deleteNodeIds).toHaveLength(1);
    expect(u3.edges).toEqual([]);
  });
});

describe('concept-linked search (6.3)', () => {
  it('ingests lecture.structured events (raw and Pub/Sub push) idempotently', async () => {
    const { app, push } = await setupConcepts();
    const e1 = envelope('d0000000-0000-4000-8000-000000000001');
    expect((await push(e1)).json()).toEqual({ status: 'processed', concepts: 3 });
    expect((await push(e1)).json()).toEqual({ status: 'duplicate' });
    const pushed = {
      message: {
        data: Buffer.from(
          JSON.stringify(envelope('d0000000-0000-4000-8000-000000000002')),
        ).toString('base64'),
        messageId: '1',
        attributes: {},
      },
      subscription: 's',
    };
    expect((await push(pushed)).json()).toMatchObject({ status: 'processed', concepts: 2 });
    expect((await push(envelope('d0000000-0000-4000-8000-00000000000f'))).json()).toMatchObject({
      status: 'skipped',
      reason: 'lecture_not_found',
    });
    expect(
      (await app.inject({ method: 'POST', url: '/v1/events/lecture-structured', payload: e1 }))
        .statusCode,
    ).toBe(401);
    expect((await push({ message: { data: '%%%' } })).statusCode).toBe(400);

    const map = (
      await app.inject({
        url: `/v1/courses/${COURSE}/concept-map?classSectionIds=${SEC_A},${SEC_B}`,
      })
    ).json<{
      nodes: { id: string; term: string; lectureCount: number }[];
      edges: { kind: string }[];
    }>();
    expect(map.nodes.map((n) => [n.term, n.lectureCount])).toEqual([
      ['Curva LM', 2],
      ['Armadilha da liquidez', 1],
      ['Curva IS', 1],
      ['Política fiscal', 1],
    ]);
    expect(map.edges.some((e) => e.kind === 'related')).toBe(true);
    // section scoping
    const onlyA = (
      await app.inject({ url: `/v1/courses/${COURSE}/concept-map?classSectionIds=${SEC_A}` })
    ).json<{ nodes: { term: string }[] }>();
    expect(onlyA.nodes.map((n) => n.term).sort()).toEqual([
      'Curva IS',
      'Curva LM',
      'Política fiscal',
    ]);
    expect(
      (
        await app.inject({ url: `/v1/courses/${COURSE}/concept-map?classSectionIds=${OTHER}` })
      ).json<{ nodes: unknown[] }>().nodes,
    ).toEqual([]);
    expect((await app.inject({ url: `/v1/courses/${COURSE}/concept-map` })).statusCode).toBe(400);
  });

  it('serves concept detail with definition variants, citations and related concepts', async () => {
    const { app, push } = await setupConcepts();
    await push(envelope('d0000000-0000-4000-8000-000000000001'));
    await push(envelope('d0000000-0000-4000-8000-000000000002'));
    const map = (
      await app.inject({
        url: `/v1/courses/${COURSE}/concept-map?classSectionIds=${SEC_A},${SEC_B}`,
      })
    ).json<{ nodes: { id: string; term: string }[] }>();
    const lm = map.nodes.find((n) => n.term === 'Curva LM');
    const detail = (
      await app.inject({ url: `/v1/concepts/${lm?.id ?? ''}?classSectionIds=${SEC_A},${SEC_B}` })
    ).json<{
      aliases: string[];
      definitions: {
        definition: string;
        citations: { scheduledClassId: string; startMs: number | null; endMs: number | null }[];
      }[];
      lectures: unknown[];
      related: { term: string; kinds: string[] }[];
    }>();
    expect(detail.aliases).toEqual(['Curva LM', 'curvas LM']);
    expect(detail.definitions).toHaveLength(2);
    expect(detail.definitions[0]?.citations[0]).toMatchObject({
      scheduledClassId: 'd0000000-0000-4000-8000-000000000001',
      startMs: 20_000,
      endMs: 29_000,
    });
    expect(detail.lectures).toHaveLength(2);
    expect(detail.related.map((r) => r.term).sort()).toEqual([
      'Armadilha da liquidez',
      'Curva IS',
      'Política fiscal',
    ]);
    // "Curva IS" names "curva LM" in its definition → explicit relation besides co-occurrence
    expect(detail.related.find((r) => r.term === 'Curva IS')?.kinds.sort()).toEqual([
      'co_occurrence',
      'related',
    ]);
    // sections without mentions see nothing
    expect(
      (await app.inject({ url: `/v1/concepts/${lm?.id ?? ''}?classSectionIds=${OTHER}` }))
        .statusCode,
    ).toBe(404);
    const onlyB = (
      await app.inject({ url: `/v1/concepts/${lm?.id ?? ''}?classSectionIds=${SEC_B}` })
    ).json<{ definitions: unknown[]; related: { term: string }[] }>();
    expect(onlyB.definitions).toHaveLength(1);
    expect(onlyB.related.map((r) => r.term)).toEqual(['Armadilha da liquidez']);
  });

  it('expands search queries with linked concepts', async () => {
    const { app, push } = await setupConcepts();
    await push(envelope('d0000000-0000-4000-8000-000000000001'));
    await push(envelope('d0000000-0000-4000-8000-000000000002'));
    const plain = (
      await app.inject({
        url: `/v1/search?q=${encodeURIComponent('armadilha da liquidez')}&classSectionIds=${SEC_A},${SEC_B}&mode=lexical`,
      })
    ).json<{ results: { segmentIndex: number }[]; concepts?: unknown }>();
    expect(plain.concepts).toBeUndefined();
    const expanded = (
      await app.inject({
        url: `/v1/search?q=${encodeURIComponent('armadilha da liquidez')}&classSectionIds=${SEC_A},${SEC_B}&mode=lexical&expand=concepts`,
      })
    ).json<{
      results: { transcriptId: string; segmentIndex: number }[];
      concepts: { term: string; relation: string; lectures: unknown[] }[];
    }>();
    expect(expanded.concepts[0]).toMatchObject({
      term: 'Armadilha da liquidez',
      relation: 'match',
    });
    expect(expanded.concepts.some((c) => c.term === 'Curva LM' && c.relation === 'related')).toBe(
      true,
    );
    // the expansion ("curva LM") surfaces lecture 1's LM passage that the plain query cannot reach
    expect(expanded.results.length).toBeGreaterThan(plain.results.length);
    const onlyA = (
      await app.inject({
        url: `/v1/search?q=${encodeURIComponent('armadilha da liquidez')}&classSectionIds=${SEC_A}&expand=concepts`,
      })
    ).json<{ concepts: unknown[] }>();
    expect(onlyA.concepts).toEqual([]);
  });
});
