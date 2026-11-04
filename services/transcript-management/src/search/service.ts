import type { Transcript, TranscriptSegment } from '../domain.js';
import { EmbeddingUnavailableError, type EmbeddingClient } from './embeddings.js';
import type { VectorStore } from '../repository.js';
import { SearchIndex, reciprocalRankFusion, type Hit } from './index.js';
import { analyze, highlight, languageOf, type Lang } from './text.js';

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
  /** Transcript language (BCP-47). */
  language: string;
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
const EXPANSION_WEIGHT = 0.5;

const keyOf = (transcriptId: string, segmentIndex: number): string =>
  `${transcriptId}:${segmentIndex}`;

export class SearchService {
  readonly index = new SearchIndex();

  constructor(
    private readonly embeddings: EmbeddingClient,
    private readonly lookup: SegmentLookup,
    private readonly warn: (msg: string, err: unknown) => void = () => undefined,
    /** Persisted vectors (segment_embeddings); avoids re-embedding on restart. */
    private readonly vectors?: VectorStore,
  ) {}

  /** Rebuilds the in-memory index from storage (service start-up with Postgres). */
  async rebuild(
    items: readonly { transcript: Transcript; segments: readonly TranscriptSegment[] }[],
  ): Promise<number> {
    for (const { transcript, segments } of items) await this.indexTranscript(transcript, segments);
    return this.index.size;
  }

  removeTranscripts(ids: readonly string[]): void {
    for (const id of ids) this.index.removeTranscript(id);
  }

  private async persist(
    t: Transcript,
    rows: { segment: TranscriptSegment; vector: number[] }[],
  ): Promise<void> {
    if (!this.vectors || !t.classSectionId || rows.length === 0) return;
    const classSectionId = t.classSectionId;
    try {
      await this.vectors.save(
        rows.map((r) => ({
          segmentId: r.segment.id,
          classSectionId,
          model: this.embeddings.model,
          vector: r.vector,
        })),
      );
    } catch (err) {
      this.warn('could not persist segment embeddings', err);
    }
  }

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
          language: languageOf(t.language),
        },
        s.text,
      );
    }
    let stored = new Map<string, number[]>();
    if (this.vectors) {
      try {
        stored = await this.vectors.load(
          indexable.map((s) => s.id),
          this.embeddings.model,
        );
      } catch (err) {
        this.warn('could not load stored embeddings', err);
      }
    }
    const missing = indexable.filter((s) => {
      const v = stored.get(s.id);
      if (v) this.index.setVector(keyOf(t.id, s.segmentIndex), v);
      return !v;
    });
    for (let i = 0; i < missing.length; i += EMBED_BATCH) {
      const batch = missing.slice(i, i + EMBED_BATCH);
      try {
        const vectors = await this.embeddings.embed(
          batch.map((s) => s.text),
          'search_index',
          t.institutionId ?? undefined,
        );
        const fresh: { segment: TranscriptSegment; vector: number[] }[] = [];
        batch.forEach((s, j) => {
          const v = vectors[j];
          if (!v) return;
          this.index.setVector(keyOf(t.id, s.segmentIndex), v);
          fresh.push({ segment: s, vector: v });
        });
        await this.persist(t, fresh);
      } catch (err) {
        this.warn('embedding batch failed; segments indexed lexically only', err);
      }
    }
  }

  async indexSegment(t: Transcript, s: TranscriptSegment): Promise<void> {
    if (!t.classSectionId) return;
    const key = keyOf(t.id, s.segmentIndex);
    this.index.upsert(
      {
        key,
        transcriptId: t.id,
        segmentIndex: s.segmentIndex,
        classSectionId: t.classSectionId,
        language: languageOf(t.language),
      },
      s.text,
    );
    try {
      const [v] = await this.embeddings.embed(
        [s.text],
        'search_index',
        t.institutionId ?? undefined,
      );
      if (v) {
        this.index.setVector(key, v);
        await this.persist(t, [{ segment: s, vector: v }]);
      }
    } catch (err) {
      this.warn('embedding failed for corrected segment; indexed lexically only', err);
    }
  }

  async search(
    q: string,
    classSectionIds: readonly string[],
    limit: number,
    mode: SearchMode,
    /** Concept-graph query expansion (6.3): related terms, weighted below the user's own words. */
    expansion: readonly string[] = [],
  ): Promise<SearchResponse> {
    const sections = new Set(classSectionIds);
    let degraded = false;
    const lists: Hit[][] = [];
    if (mode !== 'semantic') {
      lists.push(
        this.index.lexicalWeighted(
          [
            { text: q, weight: 1 },
            ...expansion.map((text) => ({ text, weight: EXPANSION_WEIGHT })),
          ],
          sections,
          CANDIDATES,
        ),
      );
    }
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
    const termsByLanguage = new Map<Lang, Set<string>>();
    const termsFor = (lang: Lang): Set<string> => {
      let t = termsByLanguage.get(lang);
      if (!t)
        termsByLanguage.set(
          lang,
          (t = new Set([q, ...expansion].flatMap((x) => analyze(x, lang)))),
        );
      return t;
    };
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
        highlight: highlight(
          segment.text,
          termsFor(doc.language ?? 'pt'),
          280,
          doc.language ?? 'pt',
        ),
        language: transcript.language,
        score: Math.round(hit.score * 1e6) / 1e6,
        ...(segment.speakerLabel ? { speakerLabel: segment.speakerLabel } : {}),
      });
    }
    return { results, mode, degraded };
  }
}
