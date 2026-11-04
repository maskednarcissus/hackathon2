import type { LectureStructure, LectureTopic } from './clients.js';
import type { Section } from './directory.js';
import { cosine, type EmbeddingClient } from './embeddings.js';
import type { Syllabus } from './repository.js';
import { daysBetween, round } from './stats.js';
import { analyze } from './text.js';

export const COVERED_THRESHOLD = 0.75;
export const PARTIAL_THRESHOLD = 0.5;
const LEXICAL_WEIGHT = 0.6;
const SEMANTIC_WEIGHT = 0.4;

export interface LectureForCoverage {
  scheduledClassId: string;
  date: string;
  lecture: LectureStructure;
}

interface Candidate {
  scheduledClassId: string;
  date: string;
  topicTitle: string;
  text: string;
  terms: Set<string>;
}

function flattenTopics(topics: readonly LectureTopic[]): LectureTopic[] {
  return topics.flatMap((t) => [t, ...flattenTopics(t.subtopics ?? [])]);
}

/** Share of the syllabus item's terms present in the candidate (token overlap, pt-BR normalised). */
export function lexicalOverlap(
  itemTerms: ReadonlySet<string>,
  candidateTerms: ReadonlySet<string>,
): number {
  if (itemTerms.size === 0) return 0;
  let hit = 0;
  for (const t of itemTerms) if (candidateTerms.has(t)) hit++;
  return hit / itemTerms.size;
}

export interface CoverageItem {
  id: string;
  title: string;
  status: 'covered' | 'partial' | 'not_covered';
  coverageScore: number;
  matchedLectures: { scheduledClassId: string; date: string; topicTitle: string; score: number }[];
  plannedWeek: number | null;
  firstCoveredWeek: number | null;
  behindSchedule: boolean;
}

export interface CoverageReport {
  courseId: string;
  institutionId: string;
  termStartDate: string | null;
  currentWeek: number | null;
  lecturesAnalysed: number;
  items: CoverageItem[];
  counts: { covered: number; partial: number; notCovered: number; total: number };
  /** covered / total. */
  coverageRatio: number | null;
  /** (covered + 0.5·partial) / total. */
  weightedCoverageRatio: number | null;
  method: {
    lexicalWeight: number;
    semanticWeight: number;
    embeddingModel: string;
    degraded: boolean;
  };
}

const weekOf = (termStart: string, date: string): number =>
  Math.floor(daysBetween(termStart, date) / 7) + 1;

/**
 * Matches syllabus items to lecture topics and concepts.
 * score = 0.6 · token overlap + 0.4 · embedding cosine; covered ≥ 0.75, partial ≥ 0.5.
 */
export async function computeCoverage(
  syllabus: Syllabus,
  sections: readonly Section[],
  lectures: readonly LectureForCoverage[],
  embeddings: EmbeddingClient,
  today: string,
): Promise<CoverageReport> {
  const candidates: Candidate[] = [];
  for (const { scheduledClassId, date, lecture } of lectures) {
    for (const t of flattenTopics(lecture.topics)) {
      const text = `${t.title}. ${t.description ?? ''}`.trim();
      candidates.push({
        scheduledClassId,
        date,
        topicTitle: t.title,
        text,
        terms: new Set(analyze(text)),
      });
    }
    for (const c of lecture.concepts) {
      const text = `${c.term}: ${c.definition}`;
      candidates.push({
        scheduledClassId,
        date,
        topicTitle: c.term,
        text,
        terms: new Set(analyze(text)),
      });
    }
  }
  const itemTexts = syllabus.items.map((i) => [i.title, ...i.keywords].join('. '));
  let itemVectors: number[][] = [];
  let candidateVectors: number[][] = [];
  let degraded = false;
  if (candidates.length > 0 && syllabus.items.length > 0) {
    try {
      const all = await embeddings.embed(
        [...itemTexts, ...candidates.map((c) => c.text)],
        syllabus.institutionId,
      );
      itemVectors = all.slice(0, itemTexts.length);
      candidateVectors = all.slice(itemTexts.length);
    } catch {
      degraded = true; // lexical-only scoring, weights renormalised
    }
  }

  const termStart =
    sections
      .map((s) => s.termStartDate)
      .filter((d): d is string => d !== null)
      .sort()[0] ??
    lectures.map((l) => l.date).sort()[0] ??
    null;
  const currentWeek = termStart && today >= termStart ? weekOf(termStart, today) : null;

  const items: CoverageItem[] = syllabus.items.map((item, i) => {
    const itemTerms = new Set(analyze(itemTexts[i] ?? item.title));
    const titleTerms = new Set(analyze(item.title));
    const bestByClass = new Map<
      string,
      { scheduledClassId: string; date: string; topicTitle: string; score: number }
    >();
    candidates.forEach((c, j) => {
      // Title terms dominate; keywords widen recall.
      const lex = Math.max(lexicalOverlap(titleTerms, c.terms), lexicalOverlap(itemTerms, c.terms));
      const iv = itemVectors[i];
      const cv = candidateVectors[j];
      const sem = !degraded && iv && cv ? Math.max(0, cosine(iv, cv)) : null;
      const score = round(sem === null ? lex : LEXICAL_WEIGHT * lex + SEMANTIC_WEIGHT * sem);
      const prev = bestByClass.get(c.scheduledClassId);
      if (score >= PARTIAL_THRESHOLD && (!prev || score > prev.score)) {
        bestByClass.set(c.scheduledClassId, {
          scheduledClassId: c.scheduledClassId,
          date: c.date,
          topicTitle: c.topicTitle,
          score,
        });
      }
    });
    const matched = [...bestByClass.values()].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : b.score - a.score,
    );
    const best = Math.max(0, ...matched.map((m) => m.score));
    const status =
      best >= COVERED_THRESHOLD ? 'covered' : best >= PARTIAL_THRESHOLD ? 'partial' : 'not_covered';
    const firstCovered = matched.find((m) => m.score >= COVERED_THRESHOLD);
    const firstCoveredWeek =
      firstCovered && termStart ? weekOf(termStart, firstCovered.date) : null;
    const behind =
      item.plannedWeek !== null &&
      currentWeek !== null &&
      (status !== 'covered'
        ? currentWeek > item.plannedWeek
        : firstCoveredWeek !== null && firstCoveredWeek > item.plannedWeek);
    return {
      id: item.id,
      title: item.title,
      status,
      coverageScore: round(best),
      matchedLectures: matched,
      plannedWeek: item.plannedWeek,
      firstCoveredWeek,
      behindSchedule: behind,
    };
  });

  const covered = items.filter((i) => i.status === 'covered').length;
  const partial = items.filter((i) => i.status === 'partial').length;
  const total = items.length;
  return {
    courseId: syllabus.courseId,
    institutionId: syllabus.institutionId,
    termStartDate: termStart,
    currentWeek,
    lecturesAnalysed: lectures.length,
    items,
    counts: { covered, partial, notCovered: total - covered - partial, total },
    coverageRatio: total > 0 ? round(covered / total) : null,
    weightedCoverageRatio: total > 0 ? round((covered + 0.5 * partial) / total) : null,
    method: {
      lexicalWeight: LEXICAL_WEIGHT,
      semanticWeight: SEMANTIC_WEIGHT,
      embeddingModel: embeddings.model,
      degraded,
    },
  };
}
