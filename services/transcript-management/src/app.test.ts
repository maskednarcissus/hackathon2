import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { formatTimestamp } from './domain.js';
import { InMemoryTranscriptRepository } from './repository.js';

const REC = '33333333-3333-4333-8333-333333333333';

function segment(i: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    segmentIndex: i,
    startMs: i * 5000,
    endMs: i * 5000 + 4500,
    text: `frase ${i}`,
    confidence: 0.9,
    ...overrides,
  };
}

function body(
  segments: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    recordingSessionId: REC,
    processingVersion: 'stt-v1',
    provider: 'google',
    model: 'chirp_2',
    segments,
    ...extra,
  };
}

const setup = (): ReturnType<typeof buildApp> =>
  buildApp({ repository: new InMemoryTranscriptRepository() });

describe('transcript-management', () => {
  it('stores a 90-minute transcript and computes stats', async () => {
    const app = setup();
    const segs = Array.from({ length: 1080 }, (_, i) =>
      segment(i, { confidence: i % 10 === 0 ? 0.4 : 0.95 }),
    );
    const res = await app.inject({ method: 'POST', url: '/v1/transcripts', payload: body(segs) });
    expect(res.statusCode).toBe(201);
    const t = res.json<{ id: string; language: string; stats: Record<string, number> }>();
    expect(t.language).toBe('pt-BR');
    expect(t.stats['segmentCount']).toBe(1080);
    expect(t.stats['durationMs']).toBe(1079 * 5000 + 4500);
    expect(t.stats['lowConfidenceSegmentCount']).toBe(108);
    expect(t.stats['averageConfidence']).toBeCloseTo(0.895, 3);

    const list = (await app.inject({ url: `/v1/transcripts?recordingSessionId=${REC}` })).json<{
      items: unknown[];
    }>();
    expect(list.items).toHaveLength(1);

    const dup = await app.inject({ method: 'POST', url: '/v1/transcripts', payload: body(segs) });
    expect(dup.statusCode).toBe(409);
  });

  it('rejects overlapping, unordered, out-of-range and identity-bearing segments', async () => {
    const app = setup();
    const cases = [
      [segment(0), segment(1, { startMs: 4000 })], // overlap
      [segment(1), segment(0)], // wrong order / index
      [segment(0, { confidence: 1.2 })],
      [segment(0, { endMs: 0 })],
      [segment(0, { speakerLabel: 'Prof. Maria' })],
      [segment(0, { words: [{ word: 'x', startMs: 9000, endMs: 9100 }] })],
    ];
    for (const segs of cases) {
      const r = await app.inject({ method: 'POST', url: '/v1/transcripts', payload: body(segs) });
      expect(r.statusCode).toBe(400);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('validation_error');
    }
  });

  it('pages segments by time window', async () => {
    const app = setup();
    const segs = Array.from({ length: 20 }, (_, i) =>
      segment(i, {
        words: [{ word: 'frase', startMs: i * 5000, endMs: i * 5000 + 300, confidence: 0.9 }],
      }),
    );
    const { id } = (
      await app.inject({ method: 'POST', url: '/v1/transcripts', payload: body(segs) })
    ).json<{ id: string }>();
    const p1 = (
      await app.inject({ url: `/v1/transcripts/${id}/segments?fromMs=10000&toMs=40000&limit=3` })
    ).json<{
      items: { segmentIndex: number; words?: unknown }[];
      nextCursor: number | null;
    }>();
    expect(p1.items.map((s) => s.segmentIndex)).toEqual([2, 3, 4]);
    expect(p1.items[0]?.words).toBeUndefined();
    expect(p1.nextCursor).toBe(5);
    const p2 = (
      await app.inject({
        url: `/v1/transcripts/${id}/segments?fromMs=10000&toMs=40000&limit=10&cursor=5&includeWords=true`,
      })
    ).json<{
      items: { segmentIndex: number; words: unknown[] }[];
      nextCursor: number | null;
    }>();
    expect(p2.items.map((s) => s.segmentIndex)).toEqual([5, 6, 7]);
    expect(p2.items[0]?.words).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(
      (await app.inject({ url: `/v1/transcripts/${id}/segments?fromMs=10&toMs=5` })).statusCode,
    ).toBe(400);
  });

  it('applies diarization speaker labels and exports text', async () => {
    const app = setup();
    const { id } = (
      await app.inject({
        method: 'POST',
        url: '/v1/transcripts',
        payload: body([segment(0, { text: 'Bom dia, turma.' }), segment(1), segment(2)]),
      })
    ).json<{ id: string }>();
    const ok = await app.inject({
      method: 'PUT',
      url: `/v1/transcripts/${id}/speakers`,
      payload: {
        speakerCount: 2,
        assignments: [
          { segmentIndex: 0, speakerLabel: 'SPEAKER_1' },
          { segmentIndex: 1, speakerLabel: 'SPEAKER_2' },
          { segmentIndex: 2, speakerLabel: 'SPEAKER_1' },
        ],
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ speakerCount: number }>().speakerCount).toBe(2);

    const named = await app.inject({
      method: 'PUT',
      url: `/v1/transcripts/${id}/speakers`,
      payload: { speakerCount: 1, assignments: [{ segmentIndex: 0, speakerLabel: 'João' }] },
    });
    expect(named.statusCode).toBe(400);
    const tooMany = await app.inject({
      method: 'PUT',
      url: `/v1/transcripts/${id}/speakers`,
      payload: {
        speakerCount: 1,
        assignments: [
          { segmentIndex: 0, speakerLabel: 'SPEAKER_1' },
          { segmentIndex: 1, speakerLabel: 'SPEAKER_2' },
        ],
      },
    });
    expect(tooMany.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'PUT',
      url: `/v1/transcripts/${id}/speakers`,
      payload: { speakerCount: 1, assignments: [{ segmentIndex: 99, speakerLabel: 'SPEAKER_1' }] },
    });
    expect(unknown.statusCode).toBe(422);

    const txt = await app.inject({ url: `/v1/transcripts/${id}/export.txt` });
    expect(txt.headers['content-type']).toContain('text/plain');
    expect(txt.body.split('\n')[0]).toBe('[00:00:00] SPEAKER_1: Bom dia, turma.');
    expect(txt.body.split('\n')[1]).toBe('[00:00:05] SPEAKER_2: frase 1');
  });

  it('returns 404 for unknown transcripts', async () => {
    const app = setup();
    const r = await app.inject({ url: '/v1/transcripts/44444444-4444-4444-8444-444444444444' });
    expect(r.statusCode).toBe(404);
    expect(r.json<{ error: { code: string } }>().error.code).toBe('transcript_not_found');
  });

  it('formats timestamps as hh:mm:ss', () => {
    expect(formatTimestamp(5_400_000)).toBe('01:30:00');
    expect(formatTimestamp(65_999)).toBe('00:01:05');
  });
});
