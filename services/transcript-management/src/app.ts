import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AcademicUnavailableError,
  StaticAcademicClient,
  type AcademicClient,
  type AuditClient,
  InMemoryAuditClient,
} from './clients.js';
import {
  computeStats,
  segmentAtVersion,
  toPlainText,
  type SegmentCorrection,
  type Transcript,
  type TranscriptSegment,
} from './domain.js';
import { HttpError, installErrorHandler } from './errors.js';
import { envelope, InMemoryEventPublisher, type EventPublisher } from './events.js';
import { VersionConflictError, type TranscriptRepository } from './repository.js';
import {
  ActorHeadersSchema,
  CorrectionSchema,
  CreateTranscriptSchema,
  SearchQuerySchema,
  SpeakerAssignmentSchema,
  VersionQuerySchema,
} from './schemas.js';
import {
  EmbeddingUnavailableError,
  FakeEmbeddingClient,
  type EmbeddingClient,
} from './search/embeddings.js';
import { SearchService } from './search/service.js';

export interface Clock {
  now(): Date;
}

export interface TranscriptDeps {
  repository: TranscriptRepository;
  academic?: AcademicClient;
  audit?: AuditClient;
  events?: EventPublisher;
  embeddings?: EmbeddingClient;
  clock?: Clock;
  idGenerator?: () => string;
  logger?: boolean;
  /** Max request body in bytes (90-minute lectures with word timings are large). */
  bodyLimit?: number;
}

const IdParams = z.object({ id: z.string().uuid() });
const SegmentParams = z.object({
  id: z.string().uuid(),
  segmentIndex: z.coerce.number().int().nonnegative(),
});

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
    version: z.enum(['latest', 'original']).default('latest'),
  })
  .refine((q) => q.fromMs === undefined || q.toMs === undefined || q.toMs > q.fromMs, {
    message: 'toMs must be greater than fromMs',
    path: ['toMs'],
  });

export function buildApp(deps: TranscriptDeps): FastifyInstance {
  const repo = deps.repository;
  const clock = deps.clock ?? { now: () => new Date() };
  const newId = deps.idGenerator ?? randomUUID;
  const academic = deps.academic ?? new StaticAcademicClient();
  const audit = deps.audit ?? new InMemoryAuditClient();
  const events = deps.events ?? new InMemoryEventPublisher();
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: deps.bodyLimit ?? 64 * 1024 * 1024,
  });
  installErrorHandler(app);

  const search = new SearchService(
    deps.embeddings ?? new FakeEmbeddingClient(),
    async (transcriptId, segmentIndex) => {
      const [transcript, segment] = await Promise.all([
        repo.findById(transcriptId),
        repo.segment(transcriptId, segmentIndex),
      ]);
      return transcript && segment ? { transcript, segment } : null;
    },
    (msg, err) => app.log.warn({ err }, msg),
  );

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

  const present = (
    s: TranscriptSegment,
    includeWords: boolean,
  ): Omit<TranscriptSegment, 'words'> & { words?: TranscriptSegment['words'] } => {
    const { words, ...rest } = s;
    return includeWords ? { ...rest, words } : rest;
  };

  function actorOf(req: FastifyRequest): {
    id: string;
    role: 'student' | 'professor' | 'coordinator' | 'admin';
  } {
    const parsed = ActorHeadersSchema.safeParse(req.headers);
    if (!parsed.success)
      throw new HttpError(
        401,
        'unauthenticated',
        'X-Actor-Id and X-Actor-Role headers are required',
      );
    return { id: parsed.data['x-actor-id'], role: parsed.data['x-actor-role'] };
  }

  /** Only the professor teaching the transcript's class (or an admin) may correct it. */
  async function authorizeCorrection(
    t: Transcript,
    actor: ReturnType<typeof actorOf>,
  ): Promise<'professor' | 'admin'> {
    if (actor.role === 'admin') return 'admin';
    if (actor.role !== 'professor')
      throw new HttpError(
        403,
        'forbidden',
        'Only the section professor or an admin may correct transcripts',
      );
    if (!t.scheduledClassId)
      throw new HttpError(
        403,
        'forbidden',
        'Transcript is not linked to a class; only admins may correct it',
      );
    let info;
    try {
      info = await academic.getScheduledClass(t.scheduledClassId);
    } catch (err) {
      if (err instanceof AcademicUnavailableError)
        throw new HttpError(502, 'academic_unavailable', err.message);
      throw err;
    }
    if (!info || info.professorId !== actor.id) {
      throw new HttpError(
        403,
        'forbidden',
        'Only the professor of this class section may correct its transcript',
      );
    }
    return 'professor';
  }

  app.get('/health', () => ({
    status: 'ok',
    service: 'transcript-management',
    indexedSegments: search.index.size,
  }));

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
    const previous = await repo.findByRecordingSession(input.recordingSessionId);
    const now = clock.now().toISOString();
    const id = newId();
    const transcript: Transcript = {
      id,
      recordingSessionId: input.recordingSessionId,
      scheduledClassId: input.scheduledClassId ?? null,
      classSectionId: input.classSectionId ?? null,
      institutionId: input.institutionId ?? null,
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
        originalText: s.text,
        version: 0,
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
    // The newest processing version of a recording replaces older ones in the search index.
    await search.indexTranscript(
      transcript,
      segments,
      previous.map((p) => p.id),
    );
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
    const query = req.query as Record<string, unknown>;
    const t = await withStats(await load(id));
    if (query['version'] === undefined) return t;
    const { version } = VersionQuerySchema.parse(query);
    const segments = (await repo.segments(id)).map((s) =>
      present(segmentAtVersion(s, version), false),
    );
    return { ...t, version, segments };
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
      version: q.version,
      items: page.map((s) => present(segmentAtVersion(s, q.version), q.includeWords)),
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
    const { version } = VersionQuerySchema.parse(req.query);
    await load(id);
    const segments = (await repo.segments(id)).map((s) => segmentAtVersion(s, version));
    return reply
      .type('text/plain; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="transcript-${id}${version === 'original' ? '-original' : ''}.txt"`,
      )
      .send(toPlainText(segments));
  });

  // ---- Corrections (phase-2 contract §7, deliverables 2.18 / 2.19) ----

  app.post('/v1/transcripts/:id/segments/:segmentIndex/corrections', async (req, reply) => {
    const { id, segmentIndex } = SegmentParams.parse(req.params);
    const actor = actorOf(req);
    const input = CorrectionSchema.parse(req.body);
    if (input.correctedBy !== undefined && input.correctedBy !== actor.id) {
      throw new HttpError(403, 'actor_mismatch', 'correctedBy must match the authenticated actor');
    }
    const t = await load(id);
    const role = await authorizeCorrection(t, actor);
    const segment = await repo.segment(id, segmentIndex);
    if (!segment)
      throw new HttpError(404, 'segment_not_found', `Segment ${segmentIndex} not found`);
    if (input.correctedText === segment.text) {
      throw new HttpError(
        422,
        'no_change',
        'correctedText is identical to the current segment text',
      );
    }
    const correction: SegmentCorrection = {
      id: newId(),
      transcriptId: id,
      segmentIndex,
      version: segment.version + 1,
      previousText: segment.text,
      correctedText: input.correctedText,
      correctedBy: actor.id,
      correctedByRole: role,
      reason: input.reason ?? null,
      createdAt: clock.now().toISOString(),
    };
    let updated: TranscriptSegment;
    try {
      updated = await repo.addCorrection(correction, correction.createdAt);
    } catch (err) {
      if (err instanceof VersionConflictError)
        throw new HttpError(409, 'version_conflict', err.message);
      throw err;
    }
    await search.indexSegment(t, updated);
    await audit.record({
      ...(t.institutionId ? { tenantId: t.institutionId } : {}),
      actorId: actor.id,
      actorType: role,
      action: 'transcript.corrected',
      resourceType: 'transcript',
      resourceId: id,
      metadata: {
        recordingSessionId: t.recordingSessionId,
        segmentIndex,
        version: correction.version,
        correctionId: correction.id,
        ...(correction.reason ? { reason: correction.reason } : {}),
      },
    });
    try {
      await events.publish(
        envelope(
          'transcript.corrected',
          'transcript-management',
          t.institutionId,
          {
            transcriptId: id,
            segmentIndex,
            version: correction.version,
            recordingSessionId: t.recordingSessionId,
            scheduledClassId: t.scheduledClassId,
            classSectionId: t.classSectionId,
          },
          clock.now(),
        ),
      );
    } catch (err) {
      app.log.warn({ err }, 'transcript.corrected publication failed');
    }
    return reply.status(201).send({ correction, segment: present(updated, false) });
  });

  app.get('/v1/transcripts/:id/segments/:segmentIndex/corrections', async (req) => {
    const { id, segmentIndex } = SegmentParams.parse(req.params);
    await load(id);
    const segment = await repo.segment(id, segmentIndex);
    if (!segment)
      throw new HttpError(404, 'segment_not_found', `Segment ${segmentIndex} not found`);
    const corrections = await repo.corrections(id, segmentIndex);
    return {
      transcriptId: id,
      segmentIndex,
      currentVersion: segment.version,
      originalText: segment.originalText,
      versions: [
        {
          version: 0,
          text: segment.originalText,
          source: 'machine',
          createdAt: null,
          correctedBy: null,
          reason: null,
        },
        ...corrections.map((c) => ({
          version: c.version,
          text: c.correctedText,
          source: c.correctedByRole,
          createdAt: c.createdAt,
          correctedBy: c.correctedBy,
          reason: c.reason,
        })),
      ],
    };
  });

  app.get('/v1/transcripts/:id/corrections', async (req) => {
    const { id } = IdParams.parse(req.params);
    await load(id);
    return { transcriptId: id, items: await repo.corrections(id) };
  });

  // ---- Search (phase-3 contract §3, deliverable 3.6) ----

  app.get('/v1/search', async (req) => {
    const q = SearchQuerySchema.parse(req.query);
    try {
      return await search.search(q.q, q.classSectionIds, q.limit, q.mode);
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError)
        throw new HttpError(502, 'embeddings_unavailable', err.message);
      throw err;
    }
  });

  return app;
}
