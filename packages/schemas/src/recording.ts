import { z } from 'zod';

export const RecordingSessionSchema = z.object({
  deviceId: z.string().uuid(),
  classroomId: z.string().uuid(),
  scheduledClassId: z.string().uuid().optional(),
  startedAt: z.string().datetime(),
  audioFormat: z.string(),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
});

export type RecordingSessionInput = z.infer<typeof RecordingSessionSchema>;
