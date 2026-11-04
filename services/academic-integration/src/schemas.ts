import { z } from 'zod';
import { isValidTimeZone } from './tz.js';

export const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const isRealDate = (s: string): boolean =>
  DATE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

const date = z.string().refine(isRealDate, 'must be a valid date (YYYY-MM-DD)');
const time = z.string().regex(TIME, 'must be a time HH:mm (24h)');
const externalId = z.string().trim().min(1).max(100);

export const TermSchema = z
  .object({ externalId, name: z.string().min(1).max(100), startDate: date, endDate: date })
  .refine((t) => t.endDate >= t.startDate, {
    message: 'endDate must be on or after startDate',
    path: ['endDate'],
  })
  .refine((t) => Date.parse(t.endDate) - Date.parse(t.startDate) <= 400 * 86_400_000, {
    message: 'term may not span more than 400 days',
    path: ['endDate'],
  });

export const CourseSchema = z.object({
  externalId,
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(255),
  discipline: z.string().min(1).max(100),
  credits: z.number().int().nonnegative().optional(),
});

export const PersonSchema = z.object({
  externalId,
  name: z.string().min(1).max(255),
  email: z
    .string()
    .email()
    .max(255)
    .transform((e) => e.toLowerCase()),
});

export const WeeklySlotSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: time,
    endTime: time,
    classroomId: z.string().uuid(),
  })
  .refine((s) => s.endTime > s.startTime, {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  });

export const ExceptionSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('cancelled'), date, reason: z.string().max(500).optional() }),
    z.object({
      type: z.literal('rescheduled'),
      date,
      startTime: time,
      endTime: time,
      classroomId: z.string().uuid().optional(),
    }),
    z.object({
      type: z.literal('extra'),
      date,
      startTime: time,
      endTime: time,
      classroomId: z.string().uuid(),
    }),
  ])
  .refine((e) => e.type === 'cancelled' || e.endTime > e.startTime, {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  });

export const ClassSectionSchema = z.object({
  externalId,
  courseExternalId: externalId,
  professorExternalId: externalId,
  sectionCode: z.string().min(1).max(50),
  schedule: z.array(WeeklySlotSchema).min(1).max(20),
  exceptions: z.array(ExceptionSchema).max(400).default([]),
  /** Shorthand for `exceptions: [{type: 'cancelled', date}]`. */
  cancelledDates: z.array(date).max(400).default([]),
});

export const EnrollmentSchema = z.object({
  studentExternalId: externalId,
  classSectionExternalId: externalId,
  status: z.enum(['active', 'withdrawn', 'completed']).default('active'),
});

export const ImportPayloadSchema = z.object({
  institutionId: z.string().uuid(),
  timezone: z
    .string()
    .refine(isValidTimeZone, 'must be a valid IANA timezone')
    .default('America/Sao_Paulo'),
  dryRun: z.boolean().default(false),
  term: TermSchema,
  courses: z.array(CourseSchema).max(5_000).default([]),
  professors: z.array(PersonSchema).max(5_000).default([]),
  students: z.array(PersonSchema).max(100_000).default([]),
  classSections: z.array(ClassSectionSchema).max(10_000).default([]),
  enrollments: z.array(EnrollmentSchema).max(500_000).default([]),
});

export type ImportPayload = z.infer<typeof ImportPayloadSchema>;
export type ImportPayloadInput = z.input<typeof ImportPayloadSchema>;

/** Renders a zod path as `classSections[2].schedule[0].startTime`. */
export function formatPath(path: readonly (string | number)[]): string {
  return path.reduce<string>(
    (acc, part) => (typeof part === 'number' ? `${acc}[${part}]` : acc ? `${acc}.${part}` : part),
    '',
  );
}
