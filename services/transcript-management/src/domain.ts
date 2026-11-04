import { LOW_CONFIDENCE_THRESHOLD } from './schemas.js';

export interface Word {
  word: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}

export interface TranscriptSegment {
  id: string;
  transcriptId: string;
  segmentIndex: number;
  startMs: number;
  endMs: number;
  /** Latest text (corrected if any correction exists). */
  text: string;
  /** Machine transcription text — never mutated. */
  originalText: string;
  /** 0 = original machine text; n = n-th correction. */
  version: number;
  confidence: number;
  language: string;
  speakerLabel: string | null;
  correctionStatus: 'original' | 'corrected';
  /** Machine word timings (relate to originalText). */
  words: Word[];
}

export interface SegmentCorrection {
  id: string;
  transcriptId: string;
  segmentIndex: number;
  version: number;
  previousText: string;
  correctedText: string;
  correctedBy: string;
  correctedByRole: 'professor' | 'admin';
  reason: string | null;
  createdAt: string;
}

/** View of a segment at a given version ('original' = untouched machine output). */
export function segmentAtVersion(
  s: TranscriptSegment,
  version: 'latest' | 'original',
): TranscriptSegment {
  return version === 'original'
    ? { ...s, text: s.originalText, version: 0, correctionStatus: 'original' }
    : s;
}

export interface Transcript {
  id: string;
  recordingSessionId: string;
  scheduledClassId: string | null;
  /** Required for search (access is scoped by class section). */
  classSectionId: string | null;
  institutionId: string | null;
  language: string;
  processingVersion: string;
  provider: string;
  model: string;
  processingStatus: 'complete';
  speakerCount: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptStats {
  segmentCount: number;
  wordCount: number;
  durationMs: number;
  speechMs: number;
  averageConfidence: number | null;
  lowConfidenceSegmentCount: number;
  lowConfidenceThreshold: number;
  correctedSegmentCount: number;
}

export function computeStats(segments: readonly TranscriptSegment[]): TranscriptStats {
  let speechMs = 0;
  let weighted = 0;
  let wordCount = 0;
  let low = 0;
  let corrected = 0;
  for (const s of segments) {
    const d = s.endMs - s.startMs;
    speechMs += d;
    weighted += s.confidence * d;
    wordCount += s.words.length > 0 ? s.words.length : s.text.split(/\s+/).filter(Boolean).length;
    if (s.confidence < LOW_CONFIDENCE_THRESHOLD) low++;
    if (s.correctionStatus === 'corrected') corrected++;
  }
  const last = segments[segments.length - 1];
  return {
    segmentCount: segments.length,
    wordCount,
    durationMs: last ? last.endMs : 0,
    speechMs,
    // duration-weighted so that long low-confidence stretches weigh more than short interjections
    averageConfidence: speechMs > 0 ? Math.round((weighted / speechMs) * 1000) / 1000 : null,
    lowConfidenceSegmentCount: low,
    lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD,
    correctedSegmentCount: corrected,
  };
}

export function formatTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export function toPlainText(segments: readonly TranscriptSegment[]): string {
  return (
    segments
      .map(
        (s) =>
          `[${formatTimestamp(s.startMs)}] ${s.speakerLabel ? `${s.speakerLabel}: ` : ''}${s.text.trim()}`,
      )
      .join('\n') + '\n'
  );
}
