import { describe, expect, it } from 'vitest';
import { computeCoverage, lexicalOverlap } from './coverage.js';
import { EmbeddingUnavailableError, type EmbeddingClient } from './embeddings.js';
import { toCsv } from './reports.js';
import { cohort, countOrSuppressed, median, percentile } from './stats.js';
import { analyze } from './text.js';

describe('toCsv (RFC 4180)', () => {
  it('quotes separators, quotes and newlines, uses CRLF and neutralises formulas', () => {
    const csv = toCsv(
      ['a', 'b', 'c'],
      [
        { a: 'x,y', b: 'diz "oi"', c: 'linha\nnova' },
        { a: null, b: 3, c: '=HYPERLINK("http://evil")' },
        { a: -1, b: true, c: '+55 11' },
      ],
    );
    expect(csv).toBe(
      'a,b,c\r\n"x,y","diz ""oi""","linha\nnova"\r\n,3,"\'=HYPERLINK(""http://evil"")"\r\n-1,true,\'+55 11\r\n',
    );
  });
});

describe('stats', () => {
  it('applies the minimum cohort of 5', () => {
    expect(cohort(4, { views: 10 })).toEqual({ suppressed: true, cohortSize: null, views: null });
    expect(cohort(5, { views: 10 })).toEqual({ suppressed: false, cohortSize: 5, views: 10 });
    expect(countOrSuppressed(0)).toEqual({ count: null, suppressed: true });
  });
  it('computes nearest-rank percentiles and medians', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([], 50)).toBeNull();
    expect(median([1, 3, 2, 4])).toBe(2.5);
  });
});

describe('coverage scoring', () => {
  const syllabus = {
    courseId: 'c',
    institutionId: 'i',
    updatedAt: 'x',
    updatedBy: null,
    items: [{ id: '1', title: 'Curva IS-LM', keywords: [], plannedWeek: null }],
  };
  const lectures = [
    {
      scheduledClassId: 'k',
      date: '2026-11-02',
      lecture: {
        lectureSummaryId: 'l',
        scheduledClassId: 'k',
        transcriptId: 't',
        title: 'x',
        createdAt: 'x',
        topics: [{ title: 'A curva IS-LM e o equilíbrio' }],
        concepts: [],
      },
    },
  ];

  it('uses pt-BR token overlap', () => {
    expect(
      lexicalOverlap(
        new Set(analyze('Avaliações institucionais')),
        new Set(analyze('avaliação institucional')),
      ),
    ).toBe(1);
  });

  it('falls back to lexical scoring when embeddings are unavailable', async () => {
    const down: EmbeddingClient = {
      model: 'down',
      embed: () => Promise.reject(new EmbeddingUnavailableError('x')),
    };
    const report = await computeCoverage(syllabus, [], lectures, down, '2026-11-10');
    expect(report.method.degraded).toBe(true);
    expect(report.items[0]).toMatchObject({ status: 'covered', coverageScore: 1 });
  });
});
