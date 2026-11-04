import type { Transcript, TranscriptSegment } from '../domain.js';
import { EmbeddingUnavailableError, type EmbeddingClient } from './embeddings.js';
import { SearchIndex, reciprocalRankFusion, type Hit } from './index.js';
import { analyze, highlight } from './text.js';

export type SearchMode = 'hybrid' | 'lexical' | 'semantic';

export interface SearchResult {
  transcriptId: string;
  scheduledClassId: string | null;
  classSectionId: string;
  segmentIndex: number;
  startMs: number;
  endMs: number;
  text: string;
  highlight: string;
  score: number;
  speakerLabel?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  mode: SearchMode;
  /** True when hybrid search fell back to lexical because embeddings were unavailable. */
  degraded: boolean;
}

export interface SegmentLookup {
  (
    transcriptId: string,
    segmentIndex: number,
  ): Promise<{ transcript: Transcript; segment: TranscriptSegment } | null>;
}

const EMBED_BATCH = 100;
const CANDIDATES = 100;
const MIN_COSINE = 0.1;

const keyOf = (transcriptId: string, segmentIndex: number): string =>
  `${transcriptId}:${segmentIndex}`;

export class SearchService {
  readonly index = new SearchIndex();

  constructor(
    private readonly embeddings: EmbeddingClient,
    private readonly lookup: SegmentLookup,
    private readonly warn: (msg: string, err: unknown) => void = () => undefined,
  ) {}

  /**
   * Indexes all segments of a transcript (latest text). Transcripts without a classSectionId are not
   * searchable because access cannot be scoped. Embedding failures leave segments lexical-only.
   */
  async indexTranscript(
    t: Transcript,
    segments: readonly TranscriptSegment[],
    supersedes: readonly string[] = [],
  ): Promise<void> {
    for (const id of supersedes) this.index.removeTranscript(id);
    if (!t.classSectionId) return;
    const classSectionId = t.classSectionId;
    const indexable = segments.filter((s) => s.text.trim() !== '');
    for (const s of indexable) {
      this.index.upsert(
        {
          key: keyOf(t.id, s.segmentIndex),
          transcriptId: t.id,
          segmentIndex: s.segmentIndex,
          classSectionId,
        },
        s.text,
      );
    }
    for (let i = 0; i < indexable.length; i += EMBED_BATCH) {
      const batch = indexable.slice(i, i + EMBED_BATCH);
      try {
        const vectors = await this.embeddings.embed(
          batch.map((s) => s.text),
          'search_index',
          t.institutionId ?? undefined,
        );
        batch.forEach((s, j) => {
          const v = vectors[j];
          if (v) this.index.setVector(keyOf(t.id, s.segmentIndex), v);
        });
      } catch (err) {
        this.warn('embedding batch failed; segments indexed lexically only', err);
      }
    }
  }

  async indexSegment(t: Transcript, s: TranscriptSegment): Promise<void> {
    if (!t.classSectionId) return;
    const key = keyOf(t.id, s.segmentIndex);
    this.index.upsert(
      { key, transcriptId: t.id, segmentIndex: s.segmentIndex, classSectionId: t.classSectionId },
      s.text,
    );
    try {
      const [v] = await this.embeddings.embed(
        [s.text],
        'search_index',
        t.institutionId ?? undefined,
      );
      if (v) this.index.setVector(key, v);
    } catch (err) {
      this.warn('embedding failed for corrected segment; indexed lexically only', err);
    }
  }

  async search(
    q: string,
    classSectionIds: readonly string[],
    limit: number,
    mode: SearchMode,
  ): Promise<SearchResponse> {
    const sections = new Set(classSectionIds);
    let degraded = false;
    const lists: Hit[][] = [];
    if (mode !== 'semantic') lists.push(this.index.lexical(q, sections, CANDIDATES));
    if (mode !== 'lexical') {
      try {
        const [qv] = await this.embeddings.embed([q], 'query');
        if (qv) lists.push(this.index.semantic(qv, sections, CANDIDATES, MIN_COSINE));
      } catch (err) {
        if (mode === 'semantic' || !(err instanceof EmbeddingUnavailableError)) throw err;
        degraded = true;
        this.warn('query embedding failed; falling back to lexical search', err);
      }
    }
    const ranked = lists.length === 1 ? (lists[0] ?? []) : reciprocalRankFusion(lists);
    const terms = new Set(analyze(q));
    const results: SearchResult[] = [];
    for (const hit of ranked) {
      if (results.length >= limit) break;
      const doc = this.index.doc(hit.key);
      if (!doc || !sections.has(doc.classSectionId)) continue; // defence in depth
      const found = await this.lookup(doc.transcriptId, doc.segmentIndex);
      if (!found) continue;
      const { transcript, segment } = found;
      results.push({
        transcriptId: transcript.id,
        scheduledClassId: transcript.scheduledClassId,
        classSectionId: doc.classSectionId,
        segmentIndex: segment.segmentIndex,
        startMs: segment.startMs,
        endMs: segment.endMs,
        text: segment.text,
        highlight: highlight(segment.text, terms),
        score: Math.round(hit.score * 1e6) / 1e6,
        ...(segment.speakerLabel ? { speakerLabel: segment.speakerLabel } : {}),
      });
    }
    return { results, mode, degraded };
  }
}
