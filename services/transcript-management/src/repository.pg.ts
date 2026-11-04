import type { SegmentCorrection, Transcript, TranscriptSegment, Word } from './domain.js';
import { iso, withTransaction, type Pool } from './platform/pg.js';
import {
  ANONYMOUS_AUTHOR_ID,
  VersionConflictError,
  type RetentionCandidate,
  type TranscriptRepository,
  type VectorStore,
} from './repository.js';

interface TranscriptRow {
  id: string;
  recording_session_id: string;
  scheduled_class_id: string | null;
  class_section_id: string | null;
  institution_id: string | null;
  language: string;
  processing_version: string;
  provider: string | null;
  model: string | null;
  speaker_count: number | null;
  diarization_method: string | null;
  diarization_version: string | null;
  created_at: Date;
  updated_at: Date;
}

interface SegmentRow {
  id: string;
  transcript_id: string;
  segment_index: number;
  start_ms: number;
  end_ms: number;
  text: string;
  original_text: string;
  version: number;
  confidence: number;
  language: string;
  speaker_label: string | null;
  correction_status: 'original' | 'corrected';
  words: Word[];
}

interface CorrectionRow {
  id: string;
  transcript_id: string;
  segment_index: number;
  version: number;
  original_text: string;
  corrected_text: string;
  corrected_by: string;
  corrected_by_role: 'professor' | 'admin' | null;
  reason: string | null;
  corrected_at: Date;
}

const T_COLUMNS = `id, recording_session_id, scheduled_class_id, class_section_id, institution_id, language,
  processing_version, provider, model, speaker_count, diarization_method, diarization_version, created_at, updated_at`;
const S_COLUMNS = `id, transcript_id, segment_index, start_ms, end_ms, text, original_text, version, confidence,
  language, speaker_label, correction_status, words`;
const C_COLUMNS = `id, transcript_id, segment_index, version, original_text, corrected_text, corrected_by,
  corrected_by_role, reason, corrected_at`;

const toTranscript = (r: TranscriptRow): Transcript => ({
  id: r.id,
  recordingSessionId: r.recording_session_id,
  scheduledClassId: r.scheduled_class_id,
  classSectionId: r.class_section_id,
  institutionId: r.institution_id,
  language: r.language,
  processingVersion: r.processing_version,
  provider: r.provider ?? 'unknown',
  model: r.model ?? 'unknown',
  processingStatus: 'complete',
  speakerCount: r.speaker_count,
  diarizationMethod: r.diarization_method,
  diarizationVersion: r.diarization_version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const toSegment = (r: SegmentRow): TranscriptSegment => ({
  id: r.id,
  transcriptId: r.transcript_id,
  segmentIndex: r.segment_index,
  startMs: r.start_ms,
  endMs: r.end_ms,
  text: r.text,
  originalText: r.original_text,
  version: r.version,
  confidence: r.confidence,
  language: r.language,
  speakerLabel: r.speaker_label,
  correctionStatus: r.correction_status,
  words: r.words,
});

const toCorrection = (r: CorrectionRow): SegmentCorrection => ({
  id: r.id,
  transcriptId: r.transcript_id,
  segmentIndex: r.segment_index,
  version: r.version,
  previousText: r.original_text,
  correctedText: r.corrected_text,
  correctedBy: r.corrected_by,
  correctedByRole: r.corrected_by_role ?? 'professor',
  reason: r.reason,
  createdAt: iso(r.corrected_at),
});

/**
 * Transcripts on `transcripts`, `transcript_segments`, `transcript_corrections` and
 * `segment_embeddings` (V001–V003). The machine text (`original_text`) is write-once — enforced by the
 * `trg_transcript_segments_original_immutable` trigger. Confidence is stored as NUMERIC(4,3).
 */
export class PgTranscriptRepository implements TranscriptRepository, VectorStore {
  constructor(private readonly pool: Pool) {}

  create(t: Transcript, segments: TranscriptSegment[]): Promise<void> {
    return withTransaction(this.pool, async (c) => {
      await c.query(
        `INSERT INTO transcripts (id, recording_session_id, scheduled_class_id, class_section_id, institution_id,
            language, processing_version, processing_status, provider, model, speaker_count, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'complete', $8, $9, $10, $11, $12)`,
        [
          t.id,
          t.recordingSessionId,
          t.scheduledClassId,
          t.classSectionId,
          t.institutionId,
          t.language,
          t.processingVersion,
          t.provider,
          t.model,
          t.speakerCount,
          t.createdAt,
          t.updatedAt,
        ],
      );
      // Bulk insert in chunks (a 90-minute lecture has ~1–2k segments).
      for (let i = 0; i < segments.length; i += 1000) {
        const chunk = segments.slice(i, i + 1000);
        await c.query(
          `INSERT INTO transcript_segments (id, transcript_id, segment_index, start_ms, end_ms, text, original_text,
              version, confidence, language, speaker_label, correction_status, words)
           SELECT u.id, $1, u.idx, u.start_ms, u.end_ms, u.text, u.text, 0, u.confidence, u.lang, u.speaker,
                  'original', u.words::jsonb
             FROM unnest($2::uuid[], $3::int[], $4::bigint[], $5::bigint[], $6::text[], $7::numeric[], $8::text[],
                         $9::text[], $10::text[])
               AS u(id, idx, start_ms, end_ms, text, confidence, lang, speaker, words)`,
          [
            t.id,
            chunk.map((s) => s.id),
            chunk.map((s) => s.segmentIndex),
            chunk.map((s) => s.startMs),
            chunk.map((s) => s.endMs),
            chunk.map((s) => s.text),
            chunk.map((s) => s.confidence),
            chunk.map((s) => s.language),
            chunk.map((s) => s.speakerLabel),
            chunk.map((s) => JSON.stringify(s.words)),
          ],
        );
      }
    });
  }

  async findById(id: string): Promise<Transcript | null> {
    const res = await this.pool.query<TranscriptRow>(
      `SELECT ${T_COLUMNS} FROM transcripts WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row ? toTranscript(row) : null;
  }

  async findByRecordingSession(recordingSessionId: string): Promise<Transcript[]> {
    const res = await this.pool.query<TranscriptRow>(
      `SELECT ${T_COLUMNS} FROM transcripts WHERE recording_session_id = $1 ORDER BY created_at`,
      [recordingSessionId],
    );
    return res.rows.map(toTranscript);
  }

  async findByRecordingAndVersion(
    recordingSessionId: string,
    processingVersion: string,
  ): Promise<Transcript | null> {
    const res = await this.pool.query<TranscriptRow>(
      `SELECT ${T_COLUMNS} FROM transcripts WHERE recording_session_id = $1 AND processing_version = $2`,
      [recordingSessionId, processingVersion],
    );
    const row = res.rows[0];
    return row ? toTranscript(row) : null;
  }

  async segments(transcriptId: string): Promise<TranscriptSegment[]> {
    const res = await this.pool.query<SegmentRow>(
      `SELECT ${S_COLUMNS} FROM transcript_segments WHERE transcript_id = $1 ORDER BY segment_index`,
      [transcriptId],
    );
    return res.rows.map(toSegment);
  }

  async segment(transcriptId: string, segmentIndex: number): Promise<TranscriptSegment | null> {
    const res = await this.pool.query<SegmentRow>(
      `SELECT ${S_COLUMNS} FROM transcript_segments WHERE transcript_id = $1 AND segment_index = $2`,
      [transcriptId, segmentIndex],
    );
    const row = res.rows[0];
    return row ? toSegment(row) : null;
  }

  applySpeakers(
    transcriptId: string,
    speakerCount: number,
    labels: Map<number, string>,
    updatedAt: string,
    diarization?: { method: string | null; version: string | null },
  ): Promise<void> {
    return withTransaction(this.pool, async (c) => {
      await c.query(
        `UPDATE transcript_segments s SET speaker_label = u.label
           FROM unnest($2::int[], $3::text[]) AS u(idx, label)
          WHERE s.transcript_id = $1 AND s.segment_index = u.idx`,
        [transcriptId, [...labels.keys()], [...labels.values()]],
      );
      await c.query(
        `UPDATE transcripts SET speaker_count = $2, updated_at = $3,
            diarization_method = CASE WHEN $4 THEN $5 ELSE diarization_method END,
            diarization_version = CASE WHEN $4 THEN $6 ELSE diarization_version END
          WHERE id = $1`,
        [
          transcriptId,
          speakerCount,
          updatedAt,
          diarization !== undefined,
          diarization?.method ?? null,
          diarization?.version ?? null,
        ],
      );
    });
  }

  addCorrection(k: SegmentCorrection, updatedAt: string): Promise<TranscriptSegment> {
    return withTransaction(this.pool, async (c) => {
      const current = await c.query<SegmentRow>(
        `SELECT ${S_COLUMNS} FROM transcript_segments WHERE transcript_id = $1 AND segment_index = $2 FOR UPDATE`,
        [k.transcriptId, k.segmentIndex],
      );
      const row = current.rows[0];
      if (!row) throw new VersionConflictError('segment not found');
      if (row.version !== k.version - 1)
        throw new VersionConflictError('segment was corrected concurrently');
      const updated = await c.query<SegmentRow>(
        `UPDATE transcript_segments SET text = $2, version = $3, correction_status = 'corrected'
          WHERE id = $1 RETURNING ${S_COLUMNS}`,
        [row.id, k.correctedText, k.version],
      );
      await c.query(
        `INSERT INTO transcript_corrections (id, transcript_segment_id, transcript_id, segment_index, version,
            original_text, corrected_text, corrected_by, corrected_by_role, reason, corrected_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          k.id,
          row.id,
          k.transcriptId,
          k.segmentIndex,
          k.version,
          k.previousText,
          k.correctedText,
          k.correctedBy,
          k.correctedByRole,
          k.reason,
          k.createdAt,
        ],
      );
      await c.query('UPDATE transcripts SET updated_at = $2 WHERE id = $1', [
        k.transcriptId,
        updatedAt,
      ]);
      const out = updated.rows[0];
      if (!out) throw new VersionConflictError('segment disappeared');
      return toSegment(out);
    });
  }

  async corrections(transcriptId: string, segmentIndex?: number): Promise<SegmentCorrection[]> {
    const res = await this.pool.query<CorrectionRow>(
      `SELECT ${C_COLUMNS} FROM transcript_corrections
        WHERE transcript_id = $1 AND ($2::int IS NULL OR segment_index = $2) ORDER BY corrected_at, version`,
      [transcriptId, segmentIndex ?? null],
    );
    return res.rows.map(toCorrection);
  }

  async retentionCandidates(
    institutionId: string,
    olderThan: string,
  ): Promise<RetentionCandidate[]> {
    const res = await this.pool.query<{
      id: string;
      created_at: Date;
      recording_session_id: string;
      class_section_id: string | null;
      authors: string[] | null;
    }>(
      `SELECT t.id, t.created_at, t.recording_session_id, t.class_section_id,
              array_remove(array_agg(DISTINCT c.corrected_by), NULL) AS authors
         FROM transcripts t LEFT JOIN transcript_corrections c ON c.transcript_id = t.id
        WHERE t.institution_id = $1 AND t.created_at < $2
        GROUP BY t.id ORDER BY t.created_at LIMIT 10000`,
      [institutionId, olderThan],
    );
    return res.rows.map((r) => ({
      id: r.id,
      createdAt: iso(r.created_at),
      recordingSessionId: r.recording_session_id,
      ...(r.class_section_id ? { classSectionId: r.class_section_id } : {}),
      ...(r.authors && r.authors.length > 0 ? { subjectIds: r.authors } : {}),
    }));
  }

  async deleteTranscripts(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const res = await this.pool.query<{ id: string }>(
      'DELETE FROM transcripts WHERE id = ANY($1::uuid[]) RETURNING id',
      [ids],
    );
    return res.rows.map((r) => r.id);
  }

  async correctionsByAuthor(authorId: string): Promise<SegmentCorrection[]> {
    const res = await this.pool.query<CorrectionRow>(
      `SELECT ${C_COLUMNS} FROM transcript_corrections WHERE corrected_by = $1 ORDER BY corrected_at`,
      [authorId],
    );
    return res.rows.map(toCorrection);
  }

  async anonymiseCorrectionAuthor(authorId: string): Promise<number> {
    const res = await this.pool.query(
      'UPDATE transcript_corrections SET corrected_by = $2 WHERE corrected_by = $1',
      [authorId, ANONYMOUS_AUTHOR_ID],
    );
    return res.rowCount ?? 0;
  }

  async indexable(): Promise<{ transcript: Transcript; segments: TranscriptSegment[] }[]> {
    const res = await this.pool.query<TranscriptRow>(
      `SELECT DISTINCT ON (recording_session_id) ${T_COLUMNS} FROM transcripts
        WHERE class_section_id IS NOT NULL ORDER BY recording_session_id, created_at DESC`,
    );
    const out: { transcript: Transcript; segments: TranscriptSegment[] }[] = [];
    for (const row of res.rows)
      out.push({ transcript: toTranscript(row), segments: await this.segments(row.id) });
    return out;
  }

  // ---- VectorStore (segment_embeddings)
  async load(segmentIds: readonly string[], model: string): Promise<Map<string, number[]>> {
    if (segmentIds.length === 0) return new Map();
    const res = await this.pool.query<{ transcript_segment_id: string; embedding: number[] }>(
      `SELECT transcript_segment_id, embedding FROM segment_embeddings
        WHERE model = $1 AND transcript_segment_id = ANY($2::uuid[])`,
      [model, segmentIds],
    );
    return new Map(res.rows.map((r) => [r.transcript_segment_id, r.embedding.map(Number)]));
  }

  async save(
    rows: { segmentId: string; classSectionId: string; model: string; vector: number[] }[],
  ): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await this.pool.query(
        `INSERT INTO segment_embeddings (transcript_segment_id, model, class_section_id, dimensions, embedding, updated_at)
         SELECT u.seg, u.model, u.section, u.dims, u.vec::real[], NOW()
           FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::int[], $5::text[]) AS u(seg, model, section, dims, vec)
         ON CONFLICT (transcript_segment_id, model)
           DO UPDATE SET embedding = EXCLUDED.embedding, dimensions = EXCLUDED.dimensions, updated_at = NOW()`,
        [
          chunk.map((r) => r.segmentId),
          chunk.map((r) => r.model),
          chunk.map((r) => r.classSectionId),
          chunk.map((r) => r.vector.length),
          chunk.map((r) => `{${r.vector.join(',')}}`),
        ],
      );
    }
  }
}
