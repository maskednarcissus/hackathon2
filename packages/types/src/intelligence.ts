export interface ExtractedEvent {
  id: string;
  type: AcademicEventType;
  title: string;
  description?: string;
  courseId: string;
  classSectionId: string;
  institutionId: string;
  eventDate?: string; // ISO 8601
  eventTime?: string; // HH:mm
  sourceRecordingId: string;
  sourceTranscriptSegmentId: string;
  confidence: ExtractionConfidence;
  confirmationStatus: ConfirmationStatus;
  createdAt: Date;
  changeHistory: EventChange[];
}

export type AcademicEventType =
  | 'examination'
  | 'quiz'
  | 'assignment'
  | 'project'
  | 'presentation'
  | 'reading_deadline'
  | 'class_cancellation'
  | 'class_reschedule'
  | 'room_change'
  | 'other';

export interface ExtractionConfidence {
  overall: number; // 0-1
  transcription: number;
  eventClassification: number;
  dateInterpretation: number;
  courseAssociation: number;
}

export type ConfirmationStatus =
  'suggested' | 'awaiting_professor' | 'awaiting_admin' | 'confirmed' | 'published' | 'rejected';

export interface EventChange {
  changedAt: Date;
  changedBy: string;
  field: string;
  previousValue: string;
  newValue: string;
  reason?: string;
}
