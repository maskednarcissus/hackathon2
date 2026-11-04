import { randomUUID } from 'node:crypto';
import type { Transcript, TranscriptSegment } from '../domain.js';
import type { EmbeddingClient } from '../search/embeddings.js';
import { analyze, languageOf } from '../search/text.js';
import { applyLecture, cosine, type LectureConcept } from './graph.js';
import type { LectureClient } from './lectures.js';
import type { ConceptEdge, ConceptMention, ConceptNode, ConceptRepository } from './model.js';

export const CONSUMER = 'transcript-management.concept-graph';
const QUERY_SIMILARITY = 0.8;
const MAX_MATCHED = 5;
const MAX_RELATED_PER_MATCH = 3;

export interface IngestResult {
  status: 'processed' | 'duplicate' | 'skipped';
  reason?: string;
  concepts?: number;
}

export interface ConceptRef {
  id: string;
  term: string;
  relation: 'match' | 'related';
  lectures: { scheduledClassId: string; classSectionId: string; lectureStartsAt: string | null }[];
}

type Lookup = {
  transcript(id: string): Promise<Transcript | null>;
  segments(transcriptId: string): Promise<TranscriptSegment[]>;
};

const lecturesOf = (mentions: readonly ConceptMention[]): ConceptRef['lectures'] => {
  const seen = new Map<string, ConceptRef['lectures'][number]>();
  for (const m of mentions)
    seen.set(m.scheduledClassId, {
      scheduledClassId: m.scheduledClassId,
      classSectionId: m.classSectionId,
      lectureStartsAt: m.lectureStartsAt,
    });
  return [...seen.values()].sort((a, b) =>
    (a.lectureStartsAt ?? '') < (b.lectureStartsAt ?? '') ? -1 : 1,
  );
};

/** Concept-linked search (Phase 6.3): graph building from lecture structures and section-scoped reads. */
export class ConceptService {
  constructor(
    private readonly repo: ConceptRepository,
    private readonly lectures: LectureClient,
    private readonly embeddings: EmbeddingClient,
    private readonly lookup: Lookup,
    private readonly now: () => Date = () => new Date(),
    private readonly warn: (msg: string, err: unknown) => void = () => undefined,
  ) {}

  /** Handles a `lecture.structured` event (idempotent by eventId and by scheduled class). */
  async ingest(eventId: string, scheduledClassId: string): Promise<IngestResult> {
    if (await this.repo.isProcessed(eventId, CONSUMER)) return { status: 'duplicate' };
    const lecture = await this.lectures.getLecture(scheduledClassId);
    const done = async (r: IngestResult): Promise<IngestResult> => {
      await this.repo.markProcessed(eventId, CONSUMER);
      return r;
    };
    if (!lecture) return done({ status: 'skipped', reason: 'lecture_not_found' });
    const transcript = await this.lookup.transcript(lecture.transcriptId);
    const courseId = lecture.courseId;
    const classSectionId = lecture.classSectionId ?? transcript?.classSectionId ?? undefined;
    if (!courseId || !classSectionId)
      return done({ status: 'skipped', reason: 'missing_course_or_section' });
    const language = transcript?.language ?? 'pt-BR';

    let vectors: (number[] | null)[] = lecture.concepts.map(() => null);
    if (lecture.concepts.length > 0) {
      try {
        vectors = await this.embeddings.embed(
          lecture.concepts.map((c) => `${c.term}: ${c.definition}`),
          'search_index',
          lecture.institutionId ?? transcript?.institutionId ?? undefined,
        );
      } catch (err) {
        this.warn('concept embeddings unavailable; merging by normalised term only', err);
      }
    }
    const concepts: LectureConcept[] = lecture.concepts.map((c, i) => ({
      term: c.term,
      definition: c.definition,
      example: c.example ?? null,
      segmentIndexes: c.segmentIndexes,
      vector: vectors[i] ?? null,
    }));
    await this.repo.applyLecture(courseId, scheduledClassId, (state) =>
      applyLecture(
        state,
        {
          scheduledClassId,
          transcriptId: lecture.transcriptId,
          lectureSummaryId: lecture.lectureSummaryId,
          classSectionId,
          courseId,
          institutionId: lecture.institutionId ?? transcript?.institutionId ?? null,
          language,
          startsAt: lecture.startsAt ?? null,
          concepts,
        },
        this.now().toISOString(),
        randomUUID,
      ),
    );
    return done({ status: 'processed', concepts: concepts.length });
  }

  /** Concepts matched by the query (and their strongest neighbours) within the caller's sections. */
  async expand(
    q: string,
    classSectionIds: readonly string[],
  ): Promise<{ concepts: ConceptRef[]; expansionTerms: string[] }> {
    const nodes = await this.repo.nodesInSections(classSectionIds);
    if (nodes.length === 0) return { concepts: [], expansionTerms: [] };
    let qVector: number[] | null = null;
    try {
      qVector = (await this.embeddings.embed([q], 'query'))[0] ?? null;
    } catch {
      qVector = null; // lexical concept matching only
    }
    const scored = nodes
      .map((n) => {
        const qTokens = new Set(analyze(q, languageOf(n.language)));
        const keyTokens = n.normalizedKey.split(' ').filter(Boolean);
        const lexical = keyTokens.length > 0 && keyTokens.every((t) => qTokens.has(t)) ? 1 : 0;
        const semantic = qVector && n.embedding ? cosine(qVector, n.embedding) : 0;
        return { node: n, score: Math.max(lexical, semantic >= QUERY_SIMILARITY ? semantic : 0) };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_MATCHED);
    if (scored.length === 0) return { concepts: [], expansionTerms: [] };

    const visible = new Map(nodes.map((n) => [n.id, n]));
    const edges = await this.repo.edgesOfCourses([...new Set(scored.map((s) => s.node.courseId))]);
    const related = new Map<string, ConceptNode>();
    for (const { node } of scored) {
      edges
        .filter((e) => e.sourceId === node.id || e.targetId === node.id)
        .sort((a, b) => b.weight - a.weight)
        .map((e) => visible.get(e.sourceId === node.id ? e.targetId : e.sourceId))
        .filter((n): n is ConceptNode => n !== undefined && !scored.some((s) => s.node.id === n.id))
        .slice(0, MAX_RELATED_PER_MATCH)
        .forEach((n) => related.set(n.id, n));
    }
    const mentions = await this.repo.mentionsInSections(classSectionIds);
    const ref = (n: ConceptNode, relation: ConceptRef['relation']): ConceptRef => ({
      id: n.id,
      term: n.term,
      relation,
      lectures: lecturesOf(mentions.filter((m) => m.nodeId === n.id)),
    });
    const qFolded = new Set(analyze(q));
    const expansionTerms = [
      ...scored.flatMap(({ node }) =>
        node.aliases.filter((a) => !analyze(a).every((t) => qFolded.has(t))),
      ),
      ...[...related.values()].map((n) => n.term),
    ];
    return {
      concepts: [
        ...scored.map((s) => ref(s.node, 'match')),
        ...[...related.values()].map((n) => ref(n, 'related')),
      ],
      expansionTerms: [...new Set(expansionTerms)],
    };
  }

  /** Concept detail scoped to the caller's sections, or null when not visible. */
  async concept(
    id: string,
    classSectionIds: readonly string[],
  ): Promise<Record<string, unknown> | null> {
    const node = await this.repo.node(id);
    if (!node) return null;
    const mentions = await this.repo.mentionsOfNode(id, classSectionIds);
    if (mentions.length === 0) return null;
    const segmentsCache = new Map<string, TranscriptSegment[]>();
    const timeRange = async (
      m: ConceptMention,
    ): Promise<{ startMs: number | null; endMs: number | null }> => {
      let segs = segmentsCache.get(m.transcriptId);
      if (!segs)
        segmentsCache.set(m.transcriptId, (segs = await this.lookup.segments(m.transcriptId)));
      const cited = segs.filter((s) => m.segmentIndexes.includes(s.segmentIndex));
      return {
        startMs: cited.length > 0 ? Math.min(...cited.map((s) => s.startMs)) : null,
        endMs: cited.length > 0 ? Math.max(...cited.map((s) => s.endMs)) : null,
      };
    };
    const variants = new Map<
      string,
      { definition: string; example: string | null; citations: Record<string, unknown>[] }
    >();
    for (const m of mentions) {
      const key = analyze(m.definition).join(' ');
      const v = variants.get(key) ?? {
        definition: m.definition,
        example: m.example,
        citations: [],
      };
      v.citations.push({
        scheduledClassId: m.scheduledClassId,
        classSectionId: m.classSectionId,
        transcriptId: m.transcriptId,
        lectureSummaryId: m.lectureSummaryId,
        segmentIndexes: m.segmentIndexes,
        lectureStartsAt: m.lectureStartsAt,
        ...(await timeRange(m)),
      });
      variants.set(key, v);
    }
    const visibleNodes = new Map(
      (await this.repo.nodesInSections(classSectionIds, node.courseId)).map((n) => [n.id, n]),
    );
    const related = (await this.repo.edgesOfNode(id))
      .map((e: ConceptEdge) => ({
        edge: e,
        other: visibleNodes.get(e.sourceId === id ? e.targetId : e.sourceId),
      }))
      .filter((x): x is { edge: ConceptEdge; other: ConceptNode } => x.other !== undefined)
      .reduce((acc, { edge, other }) => {
        // One entry per neighbour; a pair can be linked both by co-occurrence and explicitly.
        const e = acc.get(other.id) ?? {
          id: other.id,
          term: other.term,
          kinds: [] as ConceptEdge['kind'][],
          weight: 0,
        };
        e.kinds.push(edge.kind);
        e.weight += edge.weight;
        return acc.set(other.id, e);
      }, new Map<string, { id: string; term: string; kinds: ConceptEdge['kind'][]; weight: number }>());
    return {
      id: node.id,
      courseId: node.courseId,
      term: node.term,
      aliases: node.aliases,
      language: node.language,
      definitions: [...variants.values()],
      lectures: lecturesOf(mentions),
      related: [...related.values()].sort(
        (a, b) => b.weight - a.weight || a.term.localeCompare(b.term),
      ),
    };
  }

  async courseMap(
    courseId: string,
    classSectionIds: readonly string[],
  ): Promise<Record<string, unknown>> {
    const nodes = await this.repo.nodesInSections(classSectionIds, courseId);
    const mentions = await this.repo.mentionsInSections(classSectionIds, courseId);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = (await this.repo.edgesOfCourses([courseId])).filter(
      (e) => ids.has(e.sourceId) && ids.has(e.targetId),
    );
    return {
      courseId,
      nodes: nodes
        .map((n) => {
          const ms = mentions.filter((m) => m.nodeId === n.id);
          const lectures = lecturesOf(ms);
          return {
            id: n.id,
            term: n.term,
            mentionCount: ms.length,
            lectureCount: lectures.length,
            firstLectureAt: lectures[0]?.lectureStartsAt ?? null,
          };
        })
        .sort((a, b) => b.lectureCount - a.lectureCount || a.term.localeCompare(b.term)),
      edges: edges.map((e) => ({
        source: e.sourceId,
        target: e.targetId,
        kind: e.kind,
        weight: e.weight,
      })),
    };
  }
}
