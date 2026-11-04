/** Response shapes from docs/architecture/phase-2-classroom-intelligence.md (§4, §5, §7). */

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

export type ConfirmationStatus =
  'suggested' | 'awaiting_professor' | 'awaiting_admin' | 'confirmed' | 'published' | 'rejected';

export interface ExtractionConfidence {
  overall: number;
  transcription: number;
  eventClassification: number;
  dateInterpretation: number;
  courseAssociation: number;
}

export interface DateResolution {
  method: 'absolute' | 'relative' | 'next_class' | 'weekday' | 'none';
  ambiguous: boolean;
  candidates: string[];
  explanation: string;
}

export interface EventSource {
  recordingSessionId: string;
  segmentIndex: number;
  startMs: number;
  endMs: number;
  quote: string;
}

export interface CalendarConflict {
  kind:
    | 'same_section_same_day'
    | 'assessment_overlap_shared_students'
    | 'assessment_load'
    | 'non_teaching_day'
    | 'existing_event_different_date';
  severity: 'info' | 'warning' | 'blocking';
  message: string;
  relatedEventId?: string;
}

export interface EventChange {
  changedAt: string;
  changedBy: string;
  source: string;
  field: string;
  previousValue: string | null;
  newValue: string | null;
  reason?: string | null;
}

export interface EventMention {
  scheduledClassId: string;
  segmentIndex: number;
  quote: string;
}

export interface ExtractedEvent {
  id: string;
  type: AcademicEventType;
  title: string;
  description?: string | null;
  institutionId: string;
  courseId: string;
  classSectionId: string;
  scheduledClassId: string;
  transcriptId: string;
  eventDate: string | null;
  eventTime: string | null;
  timezone: string;
  dateExpression?: string | null;
  dateResolution?: DateResolution | null;
  source: EventSource;
  confidence: ExtractionConfidence;
  flags: string[];
  confirmationStatus: ConfirmationStatus;
  duplicateOf?: string | null;
  mentions?: EventMention[];
  conflicts?: CalendarConflict[];
  changeHistory?: EventChange[];
  provenance?: {
    extractor: 'llm' | 'heuristic';
    promptVersion?: string | null;
    model?: string | null;
    processingVersion: string;
  };
}

export interface TranscriptStats {
  segmentCount: number;
  wordCount: number;
  durationMs: number;
  averageConfidence: number | null;
  lowConfidenceSegmentCount: number;
  lowConfidenceThreshold: number;
}

export interface Transcript {
  id: string;
  recordingSessionId: string;
  scheduledClassId: string | null;
  language: string;
  processingVersion: string;
  provider: string;
  model: string;
  speakerCount: number | null;
  createdAt: string;
  stats?: TranscriptStats;
}

export interface TranscriptSegment {
  segmentIndex: number;
  startMs: number;
  endMs: number;
  text: string;
  /** Machine transcript text; present once a segment has been corrected (§7). */
  originalText?: string | null;
  confidence: number;
  language: string;
  speakerLabel: string | null;
  correctionStatus: 'original' | 'corrected';
}

export interface SegmentPage {
  transcriptId: string;
  items: TranscriptSegment[];
  nextCursor: number | null;
}

export interface TranscriptCorrection {
  version: number;
  correctedText: string;
  originalText?: string;
  correctedBy: string;
  correctedAt: string;
  reason?: string | null;
}
