import { describe, expect, it } from 'vitest';
import { FakeEmbeddingClient } from './embeddings.js';
import { reciprocalRankFusion } from './index.js';
import { analyze, fold, highlight, stem } from './text.js';

describe('pt-BR analysis', () => {
  it('folds accents and case', () => {
    expect(fold('Avaliação ÉTICA')).toBe('avaliacao etica');
  });

  it('removes stopwords and conflates plural / gender / derivational forms', () => {
    expect(analyze('A prova de Direito Constitucional')).toEqual([
      'prov',
      'direit',
      'constitucional',
    ]);
    expect(stem('avaliacoes')).toBe(stem('avaliacao'));
    expect(stem('provas')).toBe(stem('prova'));
    expect(stem('constitucionais')).toBe(stem('constitucional'));
    expect(stem('rapidamente')).toBe('rapida');
    expect(stem('2026')).toBe('2026');
    expect(analyze('Nossas avaliações')).toEqual(analyze('nossa AVALIACAO'));
  });

  it('highlights matching words, escapes HTML and windows long text', () => {
    const terms = new Set(analyze('avaliação'));
    expect(highlight('A <b>avaliação</b> & as Avaliações', terms)).toBe(
      'A &lt;b&gt;<mark>avaliação</mark>&lt;/b&gt; &amp; as <mark>Avaliações</mark>',
    );
    const long = `${'palavra '.repeat(100)}teorema ${'outra '.repeat(100)}`;
    const h = highlight(long, new Set(analyze('teorema')), 120);
    expect(h.startsWith('…')).toBe(true);
    expect(h.endsWith('…')).toBe(true);
    expect(h).toContain('<mark>teorema</mark>');
    expect(h.length).toBeLessThan(160);
  });
});

describe('fusion and fake embeddings', () => {
  it('reciprocal-rank fusion rewards documents ranked well in both lists', () => {
    const fused = reciprocalRankFusion([
      [
        { key: 'a', score: 9 },
        { key: 'b', score: 5 },
      ],
      [
        { key: 'b', score: 0.9 },
        { key: 'c', score: 0.8 },
      ],
    ]);
    expect(fused.map((h) => h.key)).toEqual(['b', 'a', 'c']);
  });

  it('produces deterministic unit vectors of 256 dims sharing similarity for shared terms', async () => {
    const e = new FakeEmbeddingClient();
    const [a, b, c] = await e.embed([
      'curva IS-LM e equilíbrio',
      'equilibrio da curva',
      'fotossíntese vegetal',
    ]);
    if (!a || !b || !c) throw new Error('vectors');
    expect(a).toHaveLength(256);
    expect(Math.hypot(...a)).toBeCloseTo(1, 6);
    const dot = (x: number[], y: number[]): number => x.reduce((s, v, i) => s + v * (y[i] ?? 0), 0);
    expect(dot(a, b)).toBeGreaterThan(0.5);
    expect(Math.abs(dot(a, c))).toBeLessThan(0.3);
    expect((await e.embed(['curva IS-LM e equilíbrio']))[0]).toEqual(a);
  });
});
