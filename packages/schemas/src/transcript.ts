import { z } from 'zod';

export const TranscriptSegmentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  text: z.string(),
  speakerLabel: z.string().optional(),
  confidence: z.number().min(0).max(1),
  language: z.string().default('pt-BR'),
});

export type TranscriptSegmentInput = z.infer<typeof TranscriptSegmentSchema>;
