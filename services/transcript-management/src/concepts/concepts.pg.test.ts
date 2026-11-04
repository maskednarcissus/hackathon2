import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../test/pg.js';
import { COURSE, SEC_A, SEC_B, setupConcepts } from '../test/concepts.js';
import { PgConceptRepository } from './repository.pg.js';

const envelope = (scheduledClassId: string, eventId = randomUUID()) => ({
  eventId,
  type: 'lecture.structured',
  version: 1,
  occurredAt: '2026-11-04T23:00:00.000Z',
  source: 'lecture-intelligence',
  institutionId: null,
  data: { scheduledClassId },
});

describe.skipIf(!TEST_DATABASE_URL)('concept graph on Postgres', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase(TEST_DATABASE_URL ?? '');
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('persists nodes, mentions and edges, dedupes events and serialises concurrent lectures', async () => {
    const repo = new PgConceptRepository(db.pool);
    const { app, push } = await setupConcepts(repo);
    const e1 = envelope('d0000000-0000-4000-8000-000000000001');
    // the two lectures of the course arrive concurrently
    const [r1, r2] = await Promise.all([
      push(e1),
      push(envelope('d0000000-0000-4000-8000-000000000002')),
    ]);
    expect([r1.json<{ status: string }>().status, r2.json<{ status: string }>().status]).toEqual([
      'processed',
      'processed',
    ]);
    expect((await push(e1)).json()).toEqual({ status: 'duplicate' });

    const counts = await db.pool.query<{ n: number; m: number; e: number }>(
      `SELECT (SELECT count(*) FROM concept_nodes)::int AS n, (SELECT count(*) FROM concept_mentions)::int AS m,
              (SELECT count(*) FROM concept_edges)::int AS e`,
    );
    expect(counts.rows[0]?.n).toBe(4); // "Curva LM" merged across both lectures
    expect(counts.rows[0]?.m).toBe(5);

    const map = (
      await app.inject({
        url: `/v1/courses/${COURSE}/concept-map?classSectionIds=${SEC_A},${SEC_B}`,
      })
    ).json<{ nodes: { id: string; term: string; lectureCount: number }[] }>();
    const lm = map.nodes.find((n) => n.term === 'Curva LM');
    expect(lm?.lectureCount).toBe(2);
    const detail = (
      await app.inject({ url: `/v1/concepts/${lm?.id ?? ''}?classSectionIds=${SEC_A},${SEC_B}` })
    ).json<{ aliases: string[]; related: unknown[] }>();
    expect(detail.aliases.sort()).toEqual(['Curva LM', 'curvas LM']);
    expect(detail.related).toHaveLength(3);
    const search = (
      await app.inject({
        url: `/v1/search?q=${encodeURIComponent('armadilha da liquidez')}&classSectionIds=${SEC_A},${SEC_B}&expand=concepts`,
      })
    ).json<{ concepts: { term: string }[] }>();
    expect(search.concepts[0]?.term).toBe('Armadilha da liquidez');

    // re-structuring lecture 2 with a new event replaces its mentions (no duplicates)
    expect(
      (await push(envelope('d0000000-0000-4000-8000-000000000002'))).json<{ status: string }>()
        .status,
    ).toBe('processed');
    const again = await db.pool.query<{ m: number }>(
      'SELECT count(*)::int AS m FROM concept_mentions',
    );
    expect(again.rows[0]?.m).toBe(5);
    const processed = await db.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM processed_events WHERE consumer = 'transcript-management.concept-graph'",
    );
    expect(processed.rows[0]?.n).toBe(3);
  });
});
