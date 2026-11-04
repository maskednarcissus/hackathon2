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
  text: string;
  confidence: number;
  language: string;
  speakerLabel: string | null;
  correctionStatus: 'original' | 'corrected';
  words: Word[];
}

export interface Transcript {
  id: string;
  recordingSessionId: string;
  scheduledClassId: string | null;
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
}

export function computeStats(segments: readonly TranscriptSegment[]): TranscriptStats {
  let speechMs = 0;
  let weighted = 0;
  let wordCount = 0;
  let low = 0;
  for (const s of segments) {
    const d = s.endMs - s.startMs;
    speechMs += d;
    weighted += s.confidence * d;
    wordCount += s.words.length > 0 ? s.words.length : s.text.split(/\s+/).filter(Boolean).length;
    if (s.confidence < LOW_CONFIDENCE_THRESHOLD) low++;
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
