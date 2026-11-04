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
  ): Promise<void>;
  segment(transcriptId: string, segmentIndex: number): Promise<TranscriptSegment | null>;
  /**
   * Appends a correction and updates the segment's latest text atomically. Must fail with
   * VersionConflictError if the segment's current version differs from `correction.version - 1`.
   */
  addCorrection(correction: SegmentCorrection, updatedAt: string): Promise<TranscriptSegment>;
  corrections(transcriptId: string, segmentIndex?: number): Promise<SegmentCorrection[]>;
}

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
    this.transcripts.set(transcriptId, { ...t, speakerCount, updatedAt });
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
}
