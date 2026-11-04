export interface Term {
  id: string;
  institutionId: string;
  externalId: string;
  name: string;
  startDate: string;
  endDate: string;
  timezone: string;
}

export interface Course {
  id: string;
  institutionId: string;
  academicTermId: string;
  externalId: string;
  code: string;
  name: string;
  discipline: string;
  credits: number | null;
}

export interface Person {
  id: string;
  institutionId: string;
  externalId: string;
  name: string;
  email: string;
}

export interface WeeklySlot {
  dayOfWeek: number; // 0 = Sunday
  startTime: string; // HH:mm (campus local time)
  endTime: string;
  classroomId: string;
}

export type ScheduleException =
  | { date: string; type: 'cancelled'; reason?: string | undefined }
  | {
      date: string;
      type: 'rescheduled';
      startTime: string;
      endTime: string;
      classroomId?: string | undefined;
    }
  | { date: string; type: 'extra'; startTime: string; endTime: string; classroomId: string };

export interface ClassSection {
  id: string;
  institutionId: string;
  academicTermId: string;
  externalId: string;
  courseId: string;
  professorId: string;
  sectionCode: string;
  schedule: WeeklySlot[];
  exceptions: ScheduleException[];
}

export interface Enrollment {
  id: string;
  institutionId: string;
  studentId: string;
  classSectionId: string;
  status: 'active' | 'withdrawn' | 'completed';
}

export type ScheduledClassStatus = 'scheduled' | 'cancelled';

export interface ScheduledClass {
  id: string;
  institutionId: string;
  /** Stable natural key within a section: `${localDate}|${slot}`. */
  key: string;
  classSectionId: string;
  courseId: string;
  professorId: string;
  classroomId: string;
  localDate: string;
  timezone: string;
  startsAt: string; // ISO UTC
  endsAt: string;
  status: ScheduledClassStatus;
  cancellationReason: string | null;
  source: 'timetable' | 'exception';
}

export interface ImportIssue {
  path: string;
  code: string;
  message: string;
}

export interface EntityCounts {
  created: number;
  updated: number;
  unchanged: number;
}

export interface ImportReport {
  importId: string;
  institutionId: string;
  format: 'json' | 'csv' | 'connector';
  dryRun: boolean;
  status: 'applied' | 'validated' | 'rejected';
  errors: ImportIssue[];
  warnings: ImportIssue[];
  counts: Record<
    | 'terms'
    | 'courses'
    | 'professors'
    | 'students'
    | 'classSections'
    | 'enrollments'
    | 'scheduledClasses',
    EntityCounts
  > & { scheduledClassesCancelled: number };
  createdAt: string;
}
