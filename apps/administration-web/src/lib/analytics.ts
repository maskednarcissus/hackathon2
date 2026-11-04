/** academic-analytics client (Phase 4 contract §2). Server-side only. */
import type { ApiResult } from './fleet';
import type { Open } from './open';
import { apiGet, institutionId, query } from './http';

/** A metric that may be cohort-suppressed (< 5 students). */
export type CohortNumber = number | null | { suppressed: true };

export interface CoverageMatch {
  scheduledClassId: string;
  date: string;
  topicTitle: string;
  score: number;
}

export interface CoverageItem {
  id: string;
  title: string;
  status: 'covered' | 'partial' | 'not_covered';
  coverageScore: number;
  matchedLectures: CoverageMatch[];
  plannedWeek: number | null;
  firstCoveredWeek: number | null;
  behindSchedule: boolean;
}

export interface CourseCoverage {
  courseId?: string;
  courseName?: string;
  items: CoverageItem[];
  coverageRatio: number;
}

export interface AssessmentEntry {
  eventId?: string;
  courseId: string;
  courseName?: string;
  classSectionId: string;
  sectionCode?: string;
  type: string;
  title: string;
  eventTime?: string | null;
  status: Open<'published' | 'awaiting_review'>;
}

export interface AssessmentDay {
  date: string;
  load: number;
  assessments: AssessmentEntry[];
}

export interface AssessmentCalendar {
  from: string;
  to: string;
  days: AssessmentDay[];
}

export interface AffectedSection {
  classSectionId: string;
  courseId?: string;
  courseName?: string;
  sectionCode?: string;
}

export interface AssessmentConflict {
  kind: Open<'assessment_overlap_shared_students' | 'assessment_load' | 'same_day_same_program'>;
  severity: 'info' | 'warning' | 'blocking';
  date?: string;
  message?: string;
  sections: AffectedSection[];
  affectedStudents: CohortNumber;
  suppressed?: boolean;
}

export interface ProfessorAdoption {
  professorId: string;
  professorName?: string;
  classSectionId: string;
  sectionCode?: string;
  courseId: string;
  courseName?: string;
  classesScheduled: number;
  classesCaptured: number;
  classesTranscribed: number;
  classesStructured: number;
  eventsExtracted: number;
  reviewRate: number | null;
  medianReviewLatencyHours: number | null;
  correctionsMade: number;
}

export interface SectionEngagement {
  classSectionId: string;
  courseId?: string;
  courseName?: string;
  sectionCode?: string;
  students?: CohortNumber;
  views: CohortNumber;
  searches: CohortNumber;
  assistantQuestions: CohortNumber;
  suppressed?: boolean;
}

export interface Adoption {
  from: string;
  to: string;
  professors: ProfessorAdoption[];
  sections: SectionEngagement[];
}

export const REPORT_KINDS = [
  'capture-coverage',
  'transcription-success',
  'corrections',
  'processing-latency',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_LABELS: Record<ReportKind, string> = {
  'capture-coverage': 'Cobertura de captura',
  'transcription-success': 'Sucesso da transcrição',
  corrections: 'Correções',
  'processing-latency': 'Latência de processamento',
};

export type ReportCell = string | number | boolean | null | { suppressed: true };

export interface Report {
  kind: ReportKind;
  from: string;
  to: string;
  /** Optional explicit column order/labels; otherwise keys of the first row. */
  columns?: { key: string; label?: string }[];
  rows: Record<string, ReportCell>[];
  summary?: Record<string, ReportCell>;
}

export const isReportKind = (k: string): k is ReportKind =>
  (REPORT_KINDS as readonly string[]).includes(k);

const inst = (): string => encodeURIComponent(institutionId());

export const getCoverage = (courseId: string): Promise<ApiResult<CourseCoverage>> =>
  apiGet('analytics', `/v1/courses/${encodeURIComponent(courseId)}/coverage`);

export const getAssessmentCalendar = (p: {
  from: string;
  to: string;
  programId?: string | undefined;
  courseId?: string | undefined;
}): Promise<ApiResult<AssessmentCalendar>> =>
  apiGet('analytics', `/v1/institutions/${inst()}/assessment-calendar${query(p)}`);

export const getAssessmentConflicts = (p: {
  from: string;
  to: string;
}): Promise<ApiResult<{ conflicts: AssessmentConflict[] } | AssessmentConflict[]>> =>
  apiGet('analytics', `/v1/institutions/${inst()}/assessment-conflicts${query(p)}`);

export const getAdoption = (p: { from: string; to: string }): Promise<ApiResult<Adoption>> =>
  apiGet('analytics', `/v1/institutions/${inst()}/adoption${query(p)}`);

export const getReport = (
  kind: ReportKind,
  p: { from: string; to: string; campusId?: string | undefined },
): Promise<ApiResult<Report>> =>
  apiGet(
    'analytics',
    `/v1/institutions/${inst()}/reports/${kind}${query({ ...p, format: 'json' })}`,
  );

export const reportCsvPath = (kind: ReportKind, p: { from: string; to: string }): string =>
  `/v1/institutions/${inst()}/reports/${kind}${query({ ...p, format: 'csv' })}`;

export function conflictsOf(
  data: { conflicts: AssessmentConflict[] } | AssessmentConflict[],
): AssessmentConflict[] {
  return Array.isArray(data) ? data : data.conflicts;
}
