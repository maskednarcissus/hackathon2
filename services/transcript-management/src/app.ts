import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { computeStats, toPlainText, type Transcript, type TranscriptSegment } from './domain.js';
import { HttpError, installErrorHandler } from './errors.js';
import type { TranscriptRepository } from './repository.js';
import { CreateTranscriptSchema, SpeakerAssignmentSchema } from './schemas.js';

export interface Clock {
  now(): Date;
}

export interface TranscriptDeps {
  repository: TranscriptRepository;
  clock?: Clock;
  idGenerator?: () => string;
  logger?: boolean;
  /** Max request body in bytes (90-minute lectures with word timings are large). */
  bodyLimit?: number;
}

const IdParams = z.object({ id: z.string().uuid() });

const SegmentsQuery = z
  .object({
    fromMs: z.coerce.number().int().nonnegative().optional(),
    toMs: z.coerce.number().int().nonnegative().optional(),
    cursor: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
    includeWords: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .refine((q) => q.fromMs === undefined || q.toMs === undefined || q.toMs > q.fromMs, {
    message: 'toMs must be greater than fromMs',
    path: ['toMs'],
  });

export function buildApp(deps: TranscriptDeps): FastifyInstance {
  const repo = deps.repository;
  const clock = deps.clock ?? { now: () => new Date() };
  const newId = deps.idGenerator ?? randomUUID;
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: deps.bodyLimit ?? 64 * 1024 * 1024,
  });
  installErrorHandler(app);

  async function load(id: string): Promise<Transcript> {
    const t = await repo.findById(id);
    if (!t) throw new HttpError(404, 'transcript_not_found', `Transcript ${id} not found`);
    return t;
  }

  async function withStats(
    t: Transcript,
  ): Promise<Transcript & { stats: ReturnType<typeof computeStats> }> {
    return { ...t, stats: computeStats(await repo.segments(t.id)) };
  }

  app.get('/health', () => ({ status: 'ok', service: 'transcript-management' }));

  app.post('/v1/transcripts', async (req, reply) => {
    const input = CreateTranscriptSchema.parse(req.body);
    const existing = await repo.findByRecordingAndVersion(
      input.recordingSessionId,
      input.processingVersion,
    );
    if (existing) {
      throw new HttpError(
        409,
        'transcript_exists',
        'A transcript for this recording and processing version already exists',
        {
          transcriptId: existing.id,
        },
      );
    }
    const now = clock.now().toISOString();
    const id = newId();
    const transcript: Transcript = {
      id,
      recordingSessionId: input.recordingSessionId,
      scheduledClassId: input.scheduledClassId ?? null,
      language: input.language,
      processingVersion: input.processingVersion,
      provider: input.provider,
      model: input.model,
      processingStatus: 'complete',
      speakerCount: null,
      createdAt: now,
      updatedAt: now,
    };
    const labels = new Set<string>();
    const segments: TranscriptSegment[] = input.segments.map((s) => {
      if (s.speakerLabel) labels.add(s.speakerLabel);
      return {
        id: newId(),
        transcriptId: id,
        segmentIndex: s.segmentIndex,
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text,
        confidence: s.confidence,
        language: s.language ?? input.language,
        speakerLabel: s.speakerLabel ?? null,
        correctionStatus: 'original',
        words: (s.words ?? []).map((w) => ({
          word: w.word,
          startMs: w.startMs,
          endMs: w.endMs,
          ...(w.confidence !== undefined ? { confidence: w.confidence } : {}),
        })),
      };
    });
    if (labels.size > 0) transcript.speakerCount = labels.size;
    await repo.create(transcript, segments);
    return reply.status(201).send({ ...transcript, stats: computeStats(segments) });
  });

  app.get('/v1/transcripts', async (req) => {
    const { recordingSessionId } = z
      .object({ recordingSessionId: z.string().uuid() })
      .parse(req.query);
    const items = await repo.findByRecordingSession(recordingSessionId);
    return { items: await Promise.all(items.map(withStats)) };
  });

  app.get('/v1/transcripts/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    return withStats(await load(id));
  });

  app.get('/v1/transcripts/:id/segments', async (req) => {
    const { id } = IdParams.parse(req.params);
    const q = SegmentsQuery.parse(req.query);
    await load(id);
    const all = await repo.segments(id);
    const matching = all.filter(
      (s) =>
        (q.cursor === undefined || s.segmentIndex >= q.cursor) &&
        (q.fromMs === undefined || s.endMs > q.fromMs) &&
        (q.toMs === undefined || s.startMs < q.toMs),
    );
    const page = matching.slice(0, q.limit);
    const next = matching[q.limit];
    return {
      transcriptId: id,
      items: page.map((s) => (q.includeWords ? s : { ...s, words: undefined })),
      nextCursor: next ? next.segmentIndex : null,
    };
  });

  app.put('/v1/transcripts/:id/speakers', async (req) => {
    const { id } = IdParams.parse(req.params);
    const input = SpeakerAssignmentSchema.parse(req.body);
    await load(id);
    const segments = await repo.segments(id);
    const indices = new Set(segments.map((s) => s.segmentIndex));
    const unknown = input.assignments
      .filter((a) => !indices.has(a.segmentIndex))
      .map((a) => a.segmentIndex);
    if (unknown.length > 0) {
      throw new HttpError(
        422,
        'unknown_segment',
        'Assignments reference segments that do not exist',
        {
          segmentIndexes: unknown.slice(0, 50),
        },
      );
    }
    await repo.applySpeakers(
      id,
      input.speakerCount,
      new Map(input.assignments.map((a) => [a.segmentIndex, a.speakerLabel])),
      clock.now().toISOString(),
    );
    return withStats(await load(id));
  });

  app.get('/v1/transcripts/:id/export.txt', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    await load(id);
    return reply
      .type('text/plain; charset=utf-8')
      .header('content-disposition', `attachment; filename="transcript-${id}.txt"`)
      .send(toPlainText(await repo.segments(id)));
  });

  return app;
}
