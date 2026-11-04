export const EVENT_TYPES = [
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
] as const;
export type AcademicEventType = (typeof EVENT_TYPES)[number];

/** Assessments that happen in class at a given moment (students must be present). */
export const IN_CLASS_ASSESSMENTS: ReadonlySet<AcademicEventType> = new Set([
  'examination',
  'quiz',
  'presentation',
]);

/** Everything that counts toward a student's assessment load. */
export const ASSESSMENT_TYPES: ReadonlySet<AcademicEventType> = new Set([
  'examination',
  'quiz',
  'presentation',
  'assignment',
  'project',
]);

/** Events that require the class to physically take place on that day. */
export const IN_CLASS_TYPES: ReadonlySet<AcademicEventType> = new Set([
  'examination',
  'quiz',
  'presentation',
  'class_reschedule',
  'room_change',
]);

export type CalendarEventStatus = 'published' | 'cancelled';

export interface Provenance {
  recordingSessionId: string;
  transcriptId: string;
  segmentIndex: number;
  startMs: number;
  endMs: number;
  quote: string;
  confirmedBy: string;
  confirmedAt: string;
}

export interface CalendarEvent {
  id: string;
  institutionId: string;
  courseId: string;
  classSectionId: string;
  extractedEventId: string | null;
  type: AcademicEventType;
  title: string;
  description: string | null;
  eventDate: string;
  eventTime: string | null;
  timezone: string;
  isOfficial: boolean;
  status: CalendarEventStatus;
  provenance: Provenance | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type ChangeType =
  'date_change' | 'description_change' | 'status_change' | 'cancellation' | 'other';

export type ChangeSource = 'professor' | 'admin' | 'system' | 'integration';

export interface CalendarEventChange {
  id: string;
  calendarEventId: string;
  changedAt: string;
  changedBy: string | null;
  source: ChangeSource;
  changeType: ChangeType;
  field: string;
  previousValue: string | null;
  newValue: string | null;
  reason: string | null;
}

export interface SectionRecord {
  classSectionId: string;
  institutionId: string;
  courseId: string;
  professorId: string | null;
}

export interface NonTeachingDay {
  institutionId: string;
  date: string;
  description: string;
}

export interface AcademicTerm {
  id: string;
  institutionId: string;
  name: string | null;
  startDate: string;
  endDate: string;
}

export type ConflictKind =
  | 'same_section_same_day'
  | 'assessment_overlap_shared_students'
  | 'assessment_load'
  | 'non_teaching_day'
  | 'existing_event_different_date';

export type ConflictSeverity = 'info' | 'warning' | 'blocking';

export interface Conflict {
  kind: ConflictKind;
  severity: ConflictSeverity;
  message: string;
  relatedEventId?: string;
}
