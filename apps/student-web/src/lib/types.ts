/**
 * Response shapes consumed by the student BFF. They mirror the Phase 1–3 contracts in
 * docs/architecture/*.md; fields the UI does not need are omitted.
 */

export type Role = 'student' | 'professor' | 'coordinator' | 'admin';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  institutionId: string;
  studentId?: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: User;
}

export interface SectionsResponse {
  classSectionIds: string[];
}

/* ---------- Transcripts (Phase 1 §8, Phase 2 §7) ---------- */

export interface TranscriptSegment {
  segmentIndex: number;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  language: string;
  speakerLabel?: string;
  correctionStatus?: 'original' | 'corrected';
}

export interface Transcript {
  id: string;
  recordingSessionId: string;
  scheduledClassId?: string;
  language: string;
}

export interface SearchResult {
  transcriptId: string;
  scheduledClassId: string;
  classSectionId: string;
  segmentIndex: number;
  startMs: number;
  endMs: number;
  text: string;
  highlight?: string;
  score: number;
  speakerLabel?: string;
}

/* ---------- Lectures (Phase 2 §3) ---------- */

export interface LectureTopic {
  order: number;
  title: string;
  description?: string;
  startMs?: number;
  endMs?: number;
  segmentIndexes: number[];
  subtopics?: LectureTopic[];
}

export interface LectureConcept {
  /** Stable concept id (Phase 6) — used to focus revision plans. */
  id?: string;
  term: string;
  definition: string;
  example?: string;
  segmentIndexes: number[];
}

export interface LectureQuestion {
  question: string;
  answer?: string;
  askedBy: 'student' | 'professor' | 'unknown';
  segmentIndexes: number[];
}

export interface ReadingReference {
  title: string;
  authors?: string;
  type: 'book' | 'article' | 'chapter' | 'website' | 'other';
  segmentIndexes: number[];
}

export interface LectureStructure {
  lectureSummaryId: string;
  transcriptId: string;
  scheduledClassId: string;
  title: string;
  executiveSummary: string;
  topics: LectureTopic[];
  concepts: LectureConcept[];
  questions: LectureQuestion[];
  readingReferences: ReadingReference[];
  classSectionId?: string | null;
  language?: string;
  provenance?: { promptId?: string; promptVersion?: string; model?: string };
}

/** Library entry — requires the `GET /v1/lectures` listing endpoint (see README). */
export interface LectureListItem {
  scheduledClassId: string;
  transcriptId?: string;
  lectureSummaryId?: string;
  classSectionId: string;
  courseId?: string;
  courseName?: string;
  title: string;
  startsAt: string;
  executiveSummary?: string;
  topicCount?: number;
}

export interface LectureList {
  items: LectureListItem[];
  page: number;
  pageSize: number;
  total: number;
}

/* ---------- Assistant (Phase 3 §4) ---------- */

export interface AnswerBlock {
  kind: 'professor_statement' | 'ai_explanation';
  text: string;
  citationIds: string[];
}

export interface Citation {
  id: string;
  scheduledClassId: string;
  transcriptId: string;
  segmentIndex: number;
  startMs: number;
  endMs: number;
  quote: string;
  classDate?: string;
  courseName?: string;
}

export type Refusal = 'no_evidence' | 'out_of_scope' | 'injection_suspected';

export interface AssistantAnswer {
  answerId: string;
  conversationId: string;
  answer: AnswerBlock[];
  citations: Citation[];
  grounded: boolean;
  refusal: Refusal | null;
}

/* ---------- Calendar (Phase 2 §6, Phase 3 §5) ---------- */

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

export type ConfirmationStatus =
  'suggested' | 'awaiting_professor' | 'awaiting_admin' | 'confirmed' | 'published' | 'rejected';

export interface EventProvenance {
  recordingSessionId?: string;
  transcriptId?: string;
  scheduledClassId?: string;
  segmentIndex?: number;
  startMs?: number;
  endMs?: number;
  quote?: string;
  confirmedBy?: string;
  confirmedAt?: string;
}

export interface CalendarChange {
  changedAt: string;
  changeType?: string;
  field?: string;
  previousValue?: string | null;
  newValue?: string | null;
  reason?: string;
}

export interface CalendarEvent {
  id: string;
  institutionId: string;
  courseId?: string;
  courseName?: string | null;
  classSectionId?: string;
  extractedEventId?: string;
  type: AcademicEventType;
  title: string;
  description?: string;
  eventDate: string | null;
  eventTime?: string | null;
  timezone?: string;
  isOfficial: boolean;
  status?: ConfirmationStatus | 'cancelled';
  /** Staff/detail view. */
  provenance?: EventProvenance | null;
  /** Student view (`GET /v1/students/{id}/calendar-events`). */
  source?: EventProvenance | null;
  history?: CalendarChange[];
}

export interface FeedToken {
  token: string;
  feedUrl?: string;
}

/* ---------- Notifications (Phase 3 §6) ---------- */

export type NotificationCategory =
  'new_assessment' | 'deadline_change' | 'class_cancellation' | 'lecture_summary' | 'reminder';

export interface AppNotification {
  id: string;
  /** One of NotificationCategory; kept open for forward compatibility. */
  category: string;
  title: string;
  body: string;
  createdAt: string;
  readAt?: string | null;
  link?: string;
}

export interface ChannelToggles {
  in_app: boolean;
  email: boolean;
  push: boolean;
}

export interface NotificationPreferences {
  categories: Record<NotificationCategory, ChannelToggles>;
  quietHours: { start: string; end: string; timezone: string } | null;
  reminderOffsetsHours: number[];
}

/* ---------- Content reports (Phase 3 §7) ---------- */

export type ReportResourceType =
  'lecture_summary' | 'concept' | 'transcript_segment' | 'calendar_event' | 'assistant_answer';

export type ReportReason =
  | 'incorrect_date'
  | 'incorrect_content'
  | 'misattributed_statement'
  | 'transcription_error'
  | 'other';

/* ---------- Revision (Phase 6 §6.2) ---------- */

export type RevisionKind = 'summary' | 'concept_review' | 'flashcards' | 'quiz';

export interface RevisionCitation {
  scheduledClassId: string;
  transcriptId: string;
  segmentIndexes: number[];
  startMs?: number;
  endMs?: number;
}

export interface SummaryContent {
  title: string;
  executiveSummary: string;
  topics: { title: string; startMs?: number | null; endMs?: number | null }[];
}
export interface ConceptContent {
  term: string;
  definition: string;
  example?: string;
}
export interface FlashcardContent {
  front: string;
  back: string;
}
export interface QuizContent {
  question: string;
  options: string[];
  correctOption: number;
  explanation?: string;
}

export interface RevisionSchedule {
  repetitions: number;
  intervalDays: number;
  easiness: number;
  dueAt: string;
  lastGrade: number | null;
  lastReviewedAt: string | null;
}

interface RevisionItemBase {
  id: string;
  planId: string;
  scheduledClassId: string;
  conceptIds: string[];
  sourceCitations: RevisionCitation[];
  aiGenerated: true;
  schedule?: RevisionSchedule;
}
export type RevisionItem =
  | (RevisionItemBase & { kind: 'summary'; content: SummaryContent })
  | (RevisionItemBase & { kind: 'concept_review'; content: ConceptContent })
  | (RevisionItemBase & { kind: 'flashcards'; content: FlashcardContent })
  | (RevisionItemBase & { kind: 'quiz'; content: QuizContent });

export interface RevisionPlan {
  planId: string;
  studentId: string;
  classSectionIds: string[];
  from: string | null;
  to: string | null;
  focus: string[];
  items: RevisionItem[];
  generatedAt: string;
  aiGenerated: true;
  signals?: Record<string, number>;
  validation?: { droppedItems?: number; flags?: { path: string; reason: string }[] };
  limitations: string[];
}

export interface DueItems {
  studentId: string;
  now: string;
  total: number;
  items: RevisionItem[];
}

export interface ReviewResult extends RevisionSchedule {
  itemId: string;
  grade: number;
  reviewedAt: string;
}
