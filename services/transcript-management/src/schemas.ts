import { z } from 'zod';

export const SPEAKER_LABEL = /^SPEAKER_\d{1,3}$/;
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

const confidence = z.number().min(0).max(1);
const ms = z.number().int().nonnegative();

export const WordSchema = z
  .object({ word: z.string().min(1), startMs: ms, endMs: ms, confidence: confidence.optional() })
  .refine((w) => w.endMs >= w.startMs, {
    message: 'word endMs must be >= startMs',
    path: ['endMs'],
  });

export const SegmentInputSchema = z
  .object({
    segmentIndex: z.number().int().nonnegative(),
    startMs: ms,
    endMs: ms,
    text: z.string().max(20_000),
    confidence,
    language: z
      .string()
      .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/)
      .optional(),
    speakerLabel: z
      .string()
      .regex(SPEAKER_LABEL, 'speakerLabel must be an anonymous label SPEAKER_<n>')
      .optional(),
    words: z.array(WordSchema).max(10_000).optional(),
  })
  .refine((s) => s.endMs > s.startMs, {
    message: 'endMs must be greater than startMs',
    path: ['endMs'],
  });

export type SegmentInput = z.infer<typeof SegmentInputSchema>;

export const CreateTranscriptSchema = z
  .object({
    recordingSessionId: z.string().uuid(),
    scheduledClassId: z.string().uuid().optional(),
    language: z
      .string()
      .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/)
      .default('pt-BR'),
    processingVersion: z.string().min(1).max(100),
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(100),
    segments: z.array(SegmentInputSchema).max(50_000),
  })
  .superRefine((t, ctx) => {
    t.segments.forEach((s, i) => {
      if (s.segmentIndex !== i) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments', i, 'segmentIndex'],
          message: `segmentIndex must be ${i} (segments are contiguous and ordered)`,
        });
      }
      const prev = t.segments[i - 1];
      if (prev && s.startMs < prev.endMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments', i, 'startMs'],
          message: `segment overlaps or precedes previous segment (startMs ${s.startMs} < previous endMs ${prev.endMs})`,
        });
      }
      s.words?.forEach((w, j) => {
        if (w.startMs < s.startMs || w.endMs > s.endMs) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['segments', i, 'words', j],
            message: 'word timestamps must fall within the segment',
          });
        }
      });
    });
  });

export type CreateTranscriptInput = z.infer<typeof CreateTranscriptSchema>;

export const SpeakerAssignmentSchema = z
  .object({
    speakerCount: z.number().int().min(0).max(100),
    assignments: z
      .array(
        z.object({
          segmentIndex: z.number().int().nonnegative(),
          speakerLabel: z
            .string()
            .regex(SPEAKER_LABEL, 'speakerLabel must be an anonymous label SPEAKER_<n>'),
        }),
      )
      .max(50_000),
  })
  .superRefine((v, ctx) => {
    const labels = new Set(v.assignments.map((a) => a.speakerLabel));
    if (labels.size > v.speakerCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['speakerCount'],
        message: `assignments use ${labels.size} distinct labels but speakerCount is ${v.speakerCount}`,
      });
    }
    const seen = new Set<number>();
    v.assignments.forEach((a, i) => {
      if (seen.has(a.segmentIndex)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assignments', i],
          message: 'duplicate segmentIndex',
        });
      }
      seen.add(a.segmentIndex);
    });
  });
