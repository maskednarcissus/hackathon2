import type { Transcript, TranscriptSegment } from './domain.js';

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
}

export class InMemoryTranscriptRepository implements TranscriptRepository {
  private readonly transcripts = new Map<string, Transcript>();
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
}
