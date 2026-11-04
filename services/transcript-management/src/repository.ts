import type { SegmentCorrection, Transcript, TranscriptSegment } from './domain.js';

export interface TranscriptRepository {
  create(transcript: Transcript, segments: TranscriptSegment[]): Promise<void>;
  findById(id: string): Promise<Transcript | null>;
  findByRecordingSession(recordingSessionId: string): Promise<Transcript[]>;
  findByRecordingAndVersion(
    recordingSessionId: string,
    processingVersion: string,
  ): Promise<Transcript | null>;
  segments(transcriptId: string): Promise<TranscriptSegment[]>;
  /** Applies speaker labels atomically (all or nothing). */
  applySpeakers(
    transcriptId: string,
    speakerCount: number,
    labels: Map<number, string>,
    updatedAt: string,
    diarization?: { method: string | null; version: string | null },
  ): Promise<void>;
  segment(transcriptId: string, segmentIndex: number): Promise<TranscriptSegment | null>;
  /**
   * Appends a correction and updates the segment's latest text atomically. Must fail with
   * VersionConflictError if the segment's current version differs from `correction.version - 1`.
   */
  addCorrection(correction: SegmentCorrection, updatedAt: string): Promise<TranscriptSegment>;
  corrections(transcriptId: string, segmentIndex?: number): Promise<SegmentCorrection[]>;

  // ---- governance (integration-stage §5)
  /** Transcripts of an institution created before `olderThan` (retention kind `transcript`). */
  retentionCandidates(institutionId: string, olderThan: string): Promise<RetentionCandidate[]>;
  /** Deletes transcripts with their segments, corrections and embeddings; returns deleted ids. */
  deleteTranscripts(ids: string[]): Promise<string[]>;
  correctionsByAuthor(authorId: string): Promise<SegmentCorrection[]>;
  /** Replaces the author of corrections with the anonymous id; returns the number of rows. */
  anonymiseCorrectionAuthor(authorId: string): Promise<number>;

  // ---- search warm-up
  /** Latest transcript of every recording that has a class section, with its segments. */
  indexable(): Promise<{ transcript: Transcript; segments: TranscriptSegment[] }[]>;
}

export interface RetentionCandidate {
  id: string;
  createdAt: string;
  recordingSessionId: string;
  classSectionId?: string;
  /** Professors who authored corrections (matched against `subject` legal holds). */
  subjectIds?: string[];
}

/** Persisted search vectors (segment_embeddings). */
export interface VectorStore {
  load(segmentIds: readonly string[], model: string): Promise<Map<string, number[]>>;
  save(
    rows: { segmentId: string; classSectionId: string; model: string; vector: number[] }[],
  ): Promise<void>;
}

export const ANONYMOUS_AUTHOR_ID = '00000000-0000-0000-0000-000000000000';

export class VersionConflictError extends Error {}

export class InMemoryTranscriptRepository implements TranscriptRepository {
  private readonly transcripts = new Map<string, Transcript>();
  private readonly correctionLog: SegmentCorrection[] = [];
  private readonly segmentsByTranscript = new Map<string, TranscriptSegment[]>();

  create(transcript: Transcript, segments: TranscriptSegment[]): Promise<void> {
    this.transcripts.set(transcript.id, transcript);
    this.segmentsByTranscript.set(transcript.id, segments);
    return Promise.resolve();
  }

  findById(id: string): Promise<Transcript | null> {
    return Promise.resolve(this.transcripts.get(id) ?? null);
  }

  findByRecordingSession(recordingSessionId: string): Promise<Transcript[]> {
    return Promise.resolve(
      [...this.transcripts.values()].filter((t) => t.recordingSessionId === recordingSessionId),
    );
  }

  findByRecordingAndVersion(
    recordingSessionId: string,
    processingVersion: string,
  ): Promise<Transcript | null> {
    const found = [...this.transcripts.values()].find(
      (t) =>
        t.recordingSessionId === recordingSessionId && t.processingVersion === processingVersion,
    );
    return Promise.resolve(found ?? null);
  }

  segments(transcriptId: string): Promise<TranscriptSegment[]> {
    return Promise.resolve(this.segmentsByTranscript.get(transcriptId) ?? []);
  }

  applySpeakers(
    transcriptId: string,
    speakerCount: number,
    labels: Map<number, string>,
    updatedAt: string,
    diarization?: { method: string | null; version: string | null },
  ): Promise<void> {
    const t = this.transcripts.get(transcriptId);
    if (!t) return Promise.resolve();
    const segs = this.segmentsByTranscript.get(transcriptId) ?? [];
    this.segmentsByTranscript.set(
      transcriptId,
      segs.map((s) => {
        const label = labels.get(s.segmentIndex);
        return label !== undefined ? { ...s, speakerLabel: label } : s;
      }),
    );
    this.transcripts.set(transcriptId, {
      ...t,
      speakerCount,
      updatedAt,
      ...(diarization
        ? { diarizationMethod: diarization.method, diarizationVersion: diarization.version }
        : {}),
    });
    return Promise.resolve();
  }

  segment(transcriptId: string, segmentIndex: number): Promise<TranscriptSegment | null> {
    return Promise.resolve(this.segmentsByTranscript.get(transcriptId)?.[segmentIndex] ?? null);
  }

  addCorrection(c: SegmentCorrection, updatedAt: string): Promise<TranscriptSegment> {
    const segs = this.segmentsByTranscript.get(c.transcriptId);
    const current = segs?.[c.segmentIndex];
    const t = this.transcripts.get(c.transcriptId);
    if (!segs || !current || !t)
      return Promise.reject(new VersionConflictError('segment not found'));
    if (current.version !== c.version - 1)
      return Promise.reject(new VersionConflictError('segment was corrected concurrently'));
    const updated: TranscriptSegment = {
      ...current,
      text: c.correctedText,
      version: c.version,
      correctionStatus: 'corrected',
    };
    segs[c.segmentIndex] = updated;
    this.correctionLog.push(c);
    this.transcripts.set(t.id, { ...t, updatedAt });
    return Promise.resolve(updated);
  }

  corrections(transcriptId: string, segmentIndex?: number): Promise<SegmentCorrection[]> {
    return Promise.resolve(
      this.correctionLog.filter(
        (c) =>
          c.transcriptId === transcriptId &&
          (segmentIndex === undefined || c.segmentIndex === segmentIndex),
      ),
    );
  }

  retentionCandidates(institutionId: string, olderThan: string): Promise<RetentionCandidate[]> {
    return Promise.resolve(
      [...this.transcripts.values()]
        .filter((t) => t.institutionId === institutionId && t.createdAt < olderThan)
        .map((t) => {
          const authors = [
            ...new Set(
              this.correctionLog.filter((c) => c.transcriptId === t.id).map((c) => c.correctedBy),
            ),
          ];
          return {
            id: t.id,
            createdAt: t.createdAt,
            recordingSessionId: t.recordingSessionId,
            ...(t.classSectionId ? { classSectionId: t.classSectionId } : {}),
            ...(authors.length > 0 ? { subjectIds: authors } : {}),
          };
        }),
    );
  }

  deleteTranscripts(ids: string[]): Promise<string[]> {
    const deleted = ids.filter((id) => this.transcripts.delete(id));
    for (const id of deleted) this.segmentsByTranscript.delete(id);
    const keep = this.correctionLog.filter((c) => !deleted.includes(c.transcriptId));
    this.correctionLog.splice(0, this.correctionLog.length, ...keep);
    return Promise.resolve(deleted);
  }

  correctionsByAuthor(authorId: string): Promise<SegmentCorrection[]> {
    return Promise.resolve(this.correctionLog.filter((c) => c.correctedBy === authorId));
  }

  anonymiseCorrectionAuthor(authorId: string): Promise<number> {
    let n = 0;
    this.correctionLog.forEach((c, i) => {
      if (c.correctedBy !== authorId) return;
      this.correctionLog[i] = { ...c, correctedBy: ANONYMOUS_AUTHOR_ID };
      n++;
    });
    return Promise.resolve(n);
  }

  indexable(): Promise<{ transcript: Transcript; segments: TranscriptSegment[] }[]> {
    const latest = new Map<string, Transcript>();
    for (const t of this.transcripts.values()) {
      if (!t.classSectionId) continue;
      const prev = latest.get(t.recordingSessionId);
      if (!prev || prev.createdAt < t.createdAt) latest.set(t.recordingSessionId, t);
    }
    return Promise.resolve(
      [...latest.values()].map((t) => ({
        transcript: t,
        segments: this.segmentsByTranscript.get(t.id) ?? [],
      })),
    );
  }
}
