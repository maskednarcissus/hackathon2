import { analyze, fold, languageOf } from '../search/text.js';
import type {
  ConceptEdge,
  ConceptMention,
  ConceptNode,
  CourseGraphState,
  CourseGraphUpdate,
} from './model.js';

export const MERGE_SIMILARITY = 0.88;

export interface LectureConcept {
  term: string;
  definition: string;
  example: string | null;
  segmentIndexes: number[];
  vector: number[] | null;
}

export interface LectureInput {
  scheduledClassId: string;
  transcriptId: string;
  lectureSummaryId: string;
  classSectionId: string;
  courseId: string;
  institutionId: string | null;
  language: string;
  startsAt: string | null;
  concepts: LectureConcept[];
}

export function normalizedKey(term: string, language: string): string {
  const key = analyze(term, languageOf(language)).join(' ');
  return key || fold(term).trim();
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

const normalise = (v: number[]): number[] => {
  const n = Math.hypot(...v);
  return n > 0 ? v.map((x) => x / n) : v;
};

/**
 * Applies one lecture's concepts to a course graph (pure):
 * - a concept joins the node with the same normalised term, or the most similar node when the
 *   embedding cosine is ≥ 0.88; otherwise it creates a node;
 * - the lecture's previous mentions are replaced (re-structuring a class is idempotent);
 * - nodes left without mentions are deleted; display terms are the most frequent wording;
 * - edges are recomputed: `co_occurrence` (both concepts in the same lecture, weight = lectures) and
 *   `related` (a definition/example explicitly names another concept of the course).
 */
export function applyLecture(
  state: CourseGraphState,
  lecture: LectureInput,
  now: string,
  newId: () => string,
): CourseGraphUpdate {
  const nodes = new Map(state.nodes.map((n) => [n.id, { ...n, aliases: [...n.aliases] }]));
  const otherMentions = state.mentions.filter(
    (m) => m.scheduledClassId !== lecture.scheduledClassId,
  );
  const mentionCount = new Map<string, number>();
  for (const m of otherMentions) mentionCount.set(m.nodeId, (mentionCount.get(m.nodeId) ?? 0) + 1);
  const touched = new Set<string>();
  const byNode = new Map<string, ConceptMention>();

  for (const c of lecture.concepts) {
    const key = normalizedKey(c.term, lecture.language);
    if (!key) continue;
    let node = [...nodes.values()].find((n) => n.normalizedKey === key);
    if (!node && c.vector) {
      let best: { node: ConceptNode; sim: number } | null = null;
      for (const n of nodes.values()) {
        if (!n.embedding) continue;
        const sim = cosine(c.vector, n.embedding);
        if (sim >= MERGE_SIMILARITY && (!best || sim > best.sim)) best = { node: n, sim };
      }
      node = best?.node;
    }
    if (!node) {
      node = {
        id: newId(),
        courseId: lecture.courseId,
        institutionId: lecture.institutionId,
        term: c.term.trim(),
        normalizedKey: key,
        language: lecture.language,
        aliases: [],
        embedding: c.vector ? normalise([...c.vector]) : null,
        createdAt: now,
        updatedAt: now,
      };
      nodes.set(node.id, node);
    } else if (c.vector) {
      const n = mentionCount.get(node.id) ?? 1;
      node.embedding = node.embedding
        ? normalise(node.embedding.map((x, i) => x * n + (c.vector?.[i] ?? 0)))
        : normalise([...c.vector]);
    }
    if (!node.aliases.some((a) => fold(a) === fold(c.term))) node.aliases.push(c.term.trim());
    node.updatedAt = now;
    touched.add(node.id);

    const existing = byNode.get(node.id);
    if (existing) {
      existing.segmentIndexes = [
        ...new Set([...existing.segmentIndexes, ...c.segmentIndexes]),
      ].sort((a, b) => a - b);
    } else {
      byNode.set(node.id, {
        id: newId(),
        nodeId: node.id,
        courseId: lecture.courseId,
        classSectionId: lecture.classSectionId,
        scheduledClassId: lecture.scheduledClassId,
        transcriptId: lecture.transcriptId,
        lectureSummaryId: lecture.lectureSummaryId,
        term: c.term.trim(),
        definition: c.definition.trim(),
        example: c.example?.trim() || null,
        segmentIndexes: [...new Set(c.segmentIndexes)].sort((a, b) => a - b),
        lectureStartsAt: lecture.startsAt,
        createdAt: now,
      });
    }
  }

  const lectureMentions = [...byNode.values()];
  const all = [...otherMentions, ...lectureMentions];
  const alive = new Set(all.map((m) => m.nodeId));
  const deleteNodeIds = [...nodes.keys()].filter((id) => !alive.has(id));
  for (const id of deleteNodeIds) nodes.delete(id);

  // Display term = most frequent wording (earliest wins ties).
  for (const node of nodes.values()) {
    const counts = new Map<string, { term: string; n: number; first: string }>();
    for (const m of all.filter((x) => x.nodeId === node.id)) {
      const k = fold(m.term);
      const e = counts.get(k) ?? { term: m.term, n: 0, first: m.lectureStartsAt ?? m.createdAt };
      e.n++;
      counts.set(k, e);
    }
    const best = [...counts.values()].sort((a, b) => b.n - a.n || (a.first < b.first ? -1 : 1))[0];
    if (best && best.term !== node.term) {
      node.term = best.term;
      touched.add(node.id);
    }
  }

  const edges = computeEdges(lecture.courseId, [...nodes.values()], all);
  return {
    upsertNodes: [...nodes.values()].filter((n) => touched.has(n.id)),
    deleteNodeIds,
    lectureMentions,
    edges,
  };
}

function computeEdges(
  courseId: string,
  nodes: readonly ConceptNode[],
  mentions: readonly ConceptMention[],
): ConceptEdge[] {
  const edges = new Map<string, ConceptEdge>();
  const add = (a: string, b: string, kind: ConceptEdge['kind'], scheduledClassId: string): void => {
    if (a === b) return;
    const [sourceId, targetId] = a < b ? [a, b] : [b, a];
    const key = `${sourceId}|${targetId}|${kind}`;
    const e = edges.get(key) ?? {
      courseId,
      sourceId,
      targetId,
      kind,
      weight: 0,
      scheduledClassIds: [],
    };
    if (!e.scheduledClassIds.includes(scheduledClassId)) {
      e.scheduledClassIds.push(scheduledClassId);
      e.weight++;
    }
    edges.set(key, e);
  };
  const byLecture = new Map<string, Set<string>>();
  for (const m of mentions)
    byLecture.set(
      m.scheduledClassId,
      (byLecture.get(m.scheduledClassId) ?? new Set()).add(m.nodeId),
    );
  for (const [lecture, ids] of byLecture) {
    const list = [...ids].sort();
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        add(list[i] ?? '', list[j] ?? '', 'co_occurrence', lecture);
  }
  // Explicit relation: the definition or example of a mention names another concept of the course.
  const keyed = nodes.map((n) => ({
    id: n.id,
    tokens: n.normalizedKey.split(' ').filter(Boolean),
    language: n.language,
  }));
  for (const m of mentions) {
    const node = nodes.find((n) => n.id === m.nodeId);
    const text = new Set(analyze(`${m.definition} ${m.example ?? ''}`, languageOf(node?.language)));
    for (const k of keyed) {
      if (k.id === m.nodeId || k.tokens.length === 0) continue;
      if (k.tokens.every((t) => text.has(t))) add(m.nodeId, k.id, 'related', m.scheduledClassId);
    }
  }
  return [...edges.values()].sort(
    (a, b) => b.weight - a.weight || (a.sourceId < b.sourceId ? -1 : 1),
  );
}
