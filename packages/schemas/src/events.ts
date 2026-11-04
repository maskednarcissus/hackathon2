import { z } from 'zod';

export const ExtractionConfidenceSchema = z.object({
  overall: z.number().min(0).max(1),
  transcription: z.number().min(0).max(1),
  eventClassification: z.number().min(0).max(1),
  dateInterpretation: z.number().min(0).max(1),
  courseAssociation: z.number().min(0).max(1),
});

export const AcademicEventTypeSchema = z.enum([
  'examination',
  'quiz',
  'assignment',
  'project',
  'presentation',
  'reading_deadline',
  'class_cancellation',
  'class_reschedule',
  'room_change',
  'other',
]);

export const ExtractedEventSchema = z.object({
  type: AcademicEventTypeSchema,
  title: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  courseId: z.string().uuid(),
  classSectionId: z.string().uuid(),
  institutionId: z.string().uuid(),
  eventDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  eventTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  sourceRecordingId: z.string().uuid(),
  sourceTranscriptSegmentId: z.string().uuid(),
  confidence: ExtractionConfidenceSchema,
});

export type ExtractedEventInput = z.infer<typeof ExtractedEventSchema>;
