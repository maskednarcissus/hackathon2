import type { ScheduledClass } from './domain.js';

export const IDENTIFICATION_TOLERANCE_MS = 15 * 60_000;
const MATCH_MIN_SCORE = 0.5;
const UNMATCHED_MAX_SCORE = 0.15;
const MIN_MARGIN = 0.15;

export interface Candidate {
  scheduledClass: ScheduledClass;
  score: number;
  overlapMs: number;
}

export interface IdentificationResult {
  status: 'matched' | 'ambiguous' | 'unmatched';
  confidence: number;
  best: Candidate | null;
  alternatives: Candidate[];
  reason: string;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Scores each candidate class by the Dice coefficient between the recording interval and the
 * class interval: 2·overlap / (recordingDuration + classDuration). 1.0 = identical intervals.
 * Pre/post-roll recording around a class still scores high; a recording spanning two
 * back-to-back classes scores ~0.67 against each and is reported as ambiguous.
 */
export function identifyClass(
  recording: { startedAt: Date; endedAt: Date },
  candidates: readonly ScheduledClass[],
): IdentificationResult {
  const rs = recording.startedAt.getTime();
  const re = recording.endedAt.getTime();
  const recDuration = Math.max(re - rs, 1);

  const scored = candidates
    .map((c): Candidate => {
      const cs = Date.parse(c.startsAt);
      const ce = Date.parse(c.endsAt);
      const overlapMs = Math.max(0, Math.min(re, ce) - Math.max(rs, cs));
      return {
        scheduledClass: c,
        overlapMs,
        score: round((2 * overlapMs) / (recDuration + Math.max(ce - cs, 1))),
      };
    })
    .filter((c) => c.overlapMs > 0)
    .sort((a, b) => b.score - a.score || b.overlapMs - a.overlapMs);

  const [best, second] = scored;
  if (!best || best.score <= UNMATCHED_MAX_SCORE) {
    return {
      status: 'unmatched',
      confidence: 0,
      best: null,
      alternatives: scored.slice(0, 5),
      reason: best
        ? 'overlap with scheduled classes is too small'
        : 'no scheduled class overlaps the recording',
    };
  }
  const margin = second ? best.score - second.score : best.score;
  if (best.score < MATCH_MIN_SCORE || margin < MIN_MARGIN) {
    return {
      status: 'ambiguous',
      confidence: round(best.score * Math.min(1, margin / MIN_MARGIN) * 0.5),
      best,
      alternatives: scored.slice(1, 6),
      reason:
        best.score < MATCH_MIN_SCORE
          ? 'recording only partially overlaps the best class'
          : 'several classes overlap the recording similarly',
    };
  }
  return {
    status: 'matched',
    confidence: round(Math.min(1, best.score * Math.min(1, 0.5 + margin))),
    best,
    alternatives: scored.slice(1, 6),
    reason: 'recording overlaps a single scheduled class',
  };
}
