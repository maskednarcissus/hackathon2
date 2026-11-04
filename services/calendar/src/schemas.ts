import { z } from 'zod';
import { isValidDate } from './dates.js';
import { EVENT_TYPES } from './domain.js';

const uuid = z.string().uuid();
const isoDate = z.string().refine(isValidDate, 'Expected a valid YYYY-MM-DD date');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');
const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown IANA timezone');

export const ProvenanceSchema = z.object({
  recordingSessionId: uuid,
  transcriptId: uuid,
  scheduledClassId: uuid.optional(),
  segmentIndex: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  quote: z.string().min(1).max(2000),
  confirmedBy: uuid,
  confirmedAt: z.string().datetime({ offset: true }),
});

export const CreateCalendarEventSchema = z
  .object({
    institutionId: uuid,
    courseId: uuid,
    classSectionId: uuid,
    extractedEventId: uuid.optional(),
    type: z.enum(EVENT_TYPES),
    title: z.string().trim().min(1).max(500),
    description: z.string().max(4000).optional(),
    eventDate: isoDate,
    eventTime: time.optional(),
    timezone: timezone.default('America/Sao_Paulo'),
    isOfficial: z.boolean().default(false),
    provenance: ProvenanceSchema.optional(),
    changedBy: uuid.optional(),
    changeSource: z.enum(['professor', 'admin', 'system', 'integration']).default('professor'),
    changeReason: z.string().max(1000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.extractedEventId !== undefined && v.provenance === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provenance'],
        message: 'Events published from extraction must carry source provenance',
      });
    }
    if (v.provenance && v.provenance.endMs < v.provenance.startMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provenance', 'endMs'],
        message: 'endMs must be >= startMs',
      });
    }
  });
export type CreateCalendarEventInput = z.infer<typeof CreateCalendarEventSchema>;

export const CancelEventSchema = z.object({
  actorId: uuid,
  reason: z.string().trim().min(1).max(1000),
  source: z.enum(['professor', 'admin', 'system', 'integration']).default('professor'),
});

export const ListEventsQuerySchema = z.object({
  institutionId: uuid.optional(),
  courseId: uuid.optional(),
  classSectionId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  includeCancelled: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

/** Students see cancellations by default (status is part of the student view, 3.8). */
export const StudentEventsQuerySchema = ListEventsQuerySchema.pick({
  from: true,
  to: true,
  includeCancelled: true,
}).refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
  path: ['to'],
  message: 'to must be on or after from',
});

export const HistoryQuerySchema = z.object({
  view: z.enum(['full', 'student']).default('full'),
});

export const FeedQuerySchema = z.object({
  token: z.string().min(1).max(200).optional(),
  from: isoDate.optional(),
});

export const ConflictCheckSchema = z.object({
  institutionId: uuid,
  classSectionId: uuid,
  type: z.enum(EVENT_TYPES),
  eventDate: isoDate,
  eventTime: time.optional(),
  excludeEventId: uuid.optional(),
});

const SectionSchema = z.object({
  classSectionId: uuid,
  institutionId: uuid,
  courseId: uuid,
  professorId: uuid.optional(),
  courseName: z.string().trim().min(1).max(255).optional(),
  sectionCode: z.string().trim().min(1).max(50).optional(),
});
export const SectionsSyncSchema = z.object({ sections: z.array(SectionSchema).min(1).max(5000) });

export const EnrollmentsBulkSchema = z.object({
  classSectionId: uuid,
  studentIds: z.array(uuid).max(5000),
  mode: z.enum(['replace', 'append']).default('replace'),
});

export const NonTeachingDaysSchema = z.object({
  institutionId: uuid,
  days: z
    .array(z.object({ date: isoDate, description: z.string().trim().min(1).max(255) }))
    .min(1)
    .max(1000),
});

export const TermSchema = z
  .object({
    id: uuid.optional(),
    institutionId: uuid,
    name: z.string().max(100).optional(),
    startDate: isoDate,
    endDate: isoDate,
  })
  .refine((t) => t.endDate >= t.startDate, {
    path: ['endDate'],
    message: 'endDate must be on or after startDate',
  });

export const IdParamSchema = z.object({ id: uuid });
export const StudentParamSchema = z.object({ studentId: uuid });
export const InstitutionQuerySchema = z.object({ institutionId: uuid });
