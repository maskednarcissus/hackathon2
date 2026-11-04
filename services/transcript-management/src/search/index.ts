import { analyze, type Lang } from './text.js';

export interface IndexedDoc {
  key: string; // `${transcriptId}:${segmentIndex}`
  transcriptId: string;
  segmentIndex: number;
  classSectionId: string;
  /** Analyser language of the document (from the transcript language). Default `pt`. */
  language?: Lang;
}

export interface Hit {
  key: string;
  score: number;
}

const K1 = 1.2;
const B = 0.75;

/**
 * In-memory hybrid index: BM25 postings over analysed terms + dense vectors (cosine).
 * Every query is restricted to an explicit set of class sections before ranking.
 */
export class SearchIndex {
  private readonly docs = new Map<
    string,
    IndexedDoc & { length: number; terms: Map<string, number> }
  >();
  private readonly postings = new Map<string, Map<string, number>>();
  private readonly vectors = new Map<string, Float64Array>();
  private totalLength = 0;
  /** Documents per analyser language (queries are analysed once per language present). */
  private readonly languages = new Map<Lang, number>();

  get size(): number {
    return this.docs.size;
  }

  upsert(doc: IndexedDoc, text: string, vector?: readonly number[]): void {
    this.remove(doc.key);
    const terms = new Map<string, number>();
    const language = doc.language ?? 'pt';
    const analysed = analyze(text, language);
    for (const t of analysed) terms.set(t, (terms.get(t) ?? 0) + 1);
    this.docs.set(doc.key, { ...doc, language, length: analysed.length, terms });
    this.languages.set(language, (this.languages.get(language) ?? 0) + 1);
    this.totalLength += analysed.length;
    for (const [t, tf] of terms) {
      let p = this.postings.get(t);
      if (!p) this.postings.set(t, (p = new Map<string, number>()));
      p.set(doc.key, tf);
    }
    if (vector) this.setVector(doc.key, vector);
  }

  setVector(key: string, vector: readonly number[]): void {
    if (!this.docs.has(key)) return;
    const v = Float64Array.from(vector);
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
    this.vectors.set(key, v);
  }

  remove(key: string): void {
    const doc = this.docs.get(key);
    if (!doc) return;
    for (const t of doc.terms.keys()) {
      const p = this.postings.get(t);
      p?.delete(key);
      if (p && p.size === 0) this.postings.delete(t);
    }
    this.totalLength -= doc.length;
    const language = doc.language ?? 'pt';
    const left = (this.languages.get(language) ?? 1) - 1;
    if (left > 0) this.languages.set(language, left);
    else this.languages.delete(language);
    this.docs.delete(key);
    this.vectors.delete(key);
  }

  removeTranscript(transcriptId: string): void {
    for (const doc of [...this.docs.values()])
      if (doc.transcriptId === transcriptId) this.remove(doc.key);
  }

  doc(key: string): IndexedDoc | undefined {
    return this.docs.get(key);
  }

  lexical(query: string, sections: ReadonlySet<string>, limit: number): Hit[] {
    return this.lexicalWeighted([{ text: query, weight: 1 }], sections, limit);
  }

  /**
   * BM25 over several weighted query texts (the user query plus, e.g., concept expansions). Each text
   * is analysed in every document language present, and a document only matches terms analysed in
   * its own language.
   */
  lexicalWeighted(
    queries: readonly { text: string; weight: number }[],
    sections: ReadonlySet<string>,
    limit: number,
  ): Hit[] {
    const n = this.docs.size;
    if (n === 0) return [];
    const avgdl = this.totalLength / n || 1;
    const scores = new Map<string, number>();
    for (const language of this.languages.keys()) {
      const weights = new Map<string, number>();
      for (const q of queries) {
        for (const term of new Set(analyze(q.text, language))) {
          weights.set(term, Math.max(weights.get(term) ?? 0, q.weight));
        }
      }
      for (const [term, weight] of weights) {
        const p = this.postings.get(term);
        if (!p) continue;
        const idf = Math.log(1 + (n - p.size + 0.5) / (p.size + 0.5));
        for (const [key, tf] of p) {
          const doc = this.docs.get(key);
          if (!doc || doc.language !== language || !sections.has(doc.classSectionId)) continue;
          const s = (weight * idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / avgdl));
          scores.set(key, (scores.get(key) ?? 0) + s);
        }
      }
    }
    return top(scores, limit);
  }

  semantic(
    queryVector: readonly number[],
    sections: ReadonlySet<string>,
    limit: number,
    minScore: number,
  ): Hit[] {
    let qn = 0;
    for (const x of queryVector) qn += x * x;
    qn = Math.sqrt(qn);
    if (qn === 0) return [];
    const scores = new Map<string, number>();
    for (const [key, v] of this.vectors) {
      const doc = this.docs.get(key);
      if (!doc || !sections.has(doc.classSectionId)) continue;
      let dot = 0;
      const len = Math.min(v.length, queryVector.length);
      for (let i = 0; i < len; i++) dot += (v[i] ?? 0) * (queryVector[i] ?? 0);
      const cos = dot / qn;
      if (cos >= minScore) scores.set(key, cos);
    }
    return top(scores, limit);
  }
}

function top(scores: Map<string, number>, limit: number): Hit[] {
  return [...scores.entries()]
    .map(([key, score]) => ({ key, score }))
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1))
    .slice(0, limit);
}

/** Reciprocal-rank fusion: Σ 1 / (k + rank), rank starting at 1. */
export function reciprocalRankFusion(lists: readonly Hit[][], k = 60): Hit[] {
  const fused = new Map<string, number>();
  for (const list of lists) {
    list.forEach((hit, i) => fused.set(hit.key, (fused.get(hit.key) ?? 0) + 1 / (k + i + 1)));
  }
  return top(fused, Number.POSITIVE_INFINITY);
}
