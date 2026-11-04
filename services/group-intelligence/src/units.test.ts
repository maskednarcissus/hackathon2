import { describe, expect, it } from 'vitest';
import { asksForIndividuals, extractNumbers, groundAnswer } from './investigation.js';
import { engagementAggregate } from './pipeline.js';
import {
  DEFAULT_PRICING,
  hardwareDailyCost,
  PricingSchema,
  storageCost,
  sttCost,
} from './pricing.js';
import { isoWeek } from './stats.js';

const section = (activeStudents: number | null, cohortSize: number | null, suppressed = false) => ({
  classSectionId: 's',
  courseId: null,
  engagement: {
    suppressed,
    cohortSize,
    activeStudents,
    views: 10,
    searches: 4,
    assistantQuestions: 2,
  },
});

describe('engagementAggregate', () => {
  it('drops sections below the cohort and suppresses small totals', () => {
    expect(engagementAggregate([section(40, 40), section(3, 3)])).toEqual({
      activeStudents: 40,
      assistantQuestions: 2,
      searches: 4,
    });
    expect(engagementAggregate([section(3, 3), section(4, 4)])).toEqual({
      activeStudents: null,
      assistantQuestions: null,
      searches: null,
    });
    expect(engagementAggregate([section(9, 9, true)])).toEqual({
      activeStudents: null,
      assistantQuestions: null,
      searches: null,
    });
  });
});

describe('numeric grounding', () => {
  it('parses pt-BR and en number formats', () => {
    expect(extractNumbers('R$ 1.234,56 e 83,3% e 0.9 e 1.200').map((n) => n.candidates)).toEqual([
      [1234.56],
      [83.3],
      [0.9],
      [1200, 1.2],
    ]);
  });

  it('removes sentences with numbers not present in the results', () => {
    const allowed = new Set([0.9, 90, 52]);
    expect(
      groundAnswer(
        'Alfa capturou 90% das aulas. Beta tem 17 campi. Há 52 estudantes ativos.',
        allowed,
      ),
    ).toEqual({
      answer: 'Alfa capturou 90% das aulas. Há 52 estudantes ativos.',
      removed: ['Beta tem 17 campi.'],
    });
  });
});

describe('individual-data refusal', () => {
  it.each([
    ['Quais alunos mais usam o assistente?', true],
    ['Qual é o aluno com mais faltas?', true],
    ['Me dê a lista de estudantes da Faculdade Alfa', true],
    ['Qual o e-mail dos alunos do curso de Direito?', true],
    ['Quantos alunos ativos tivemos em outubro?', false],
    ['Qual instituição tem a melhor taxa de captura?', false],
    ['Compare o custo por aula entre as instituições', false],
  ])('%s → %s', (q, expected) => {
    expect(asksForIndividuals(q)).toBe(expected);
  });
});

describe('pricing', () => {
  it('estimates STT, storage and hardware costs', () => {
    expect(sttCost(DEFAULT_PRICING, 10)).toBeCloseTo(14.4, 6);
    expect(storageCost(DEFAULT_PRICING, 1)).toBeCloseTo(90 * 0.00192 * 0.023 * 3, 6);
    expect(hardwareDailyCost(DEFAULT_PRICING, 36, '2026-02-10')).toBeCloseTo(
      (36 * 450) / 36 / 28,
      5,
    );
    expect(() => PricingSchema.parse({ ...DEFAULT_PRICING, asOf: 'yesterday' })).toThrow();
  });
});

describe('isoWeek', () => {
  it.each([
    ['2026-11-04', '2026-W45'],
    ['2026-01-01', '2026-W01'],
    ['2027-01-01', '2026-W53'],
    ['2024-12-30', '2025-W01'],
  ])('%s → %s', (d, w) => expect(isoWeek(d)).toBe(w));
});
