import type { Directory, Section } from './directory.js';
import type { UpstreamClients } from './fakes.js';
import { addDays, countOrSuppressed, MIN_COHORT } from './stats.js';

export const ASSESSMENT_TYPES = new Set([
  'examination',
  'quiz',
  'assignment',
  'project',
  'presentation',
  'reading_deadline',
]);
const PENDING_STATUSES = new Set([
  'suggested',
  'awaiting_professor',
  'awaiting_admin',
  'confirmed',
]);
const LOAD_WINDOW_DAYS = 7;
const LOAD_THRESHOLD = 3;

export interface Assessment {
  id: string;
  source: 'calendar' | 'event_extraction';
  status: 'published' | 'awaiting_review';
  type: string;
  title: string;
  date: string;
  time: string | null;
  isOfficial: boolean;
  classSectionId: string;
  courseId: string;
  courseCode: string | null;
  courseName: string | null;
  sectionCode: string | null;
  programId: string | null;
}

export interface AssessmentFilter {
  programId?: string;
  courseId?: string;
  includePending: boolean;
}

/** Published calendar assessments + extracted assessments still awaiting review (not yet in the calendar). */
export async function loadAssessments(
  institutionId: string,
  from: string,
  to: string,
  filter: AssessmentFilter,
  directory: Directory,
  up: UpstreamClients,
): Promise<{ assessments: Assessment[]; sections: Map<string, Section> }> {
  const sections = new Map(
    (await directory.sections(institutionId)).map((s) => [s.classSectionId, s]),
  );
  const keep = (s: Section | undefined): s is Section =>
    s !== undefined &&
    (filter.programId === undefined || s.programId === filter.programId) &&
    (filter.courseId === undefined || s.courseId === filter.courseId);
  const describe = (
    s: Section,
  ): Pick<
    Assessment,
    'classSectionId' | 'courseId' | 'courseCode' | 'courseName' | 'sectionCode' | 'programId'
  > => ({
    classSectionId: s.classSectionId,
    courseId: s.courseId,
    courseCode: s.courseCode,
    courseName: s.courseName,
    sectionCode: s.sectionCode,
    programId: s.programId,
  });

  const out: Assessment[] = [];
  for (const e of await up.calendar.listEvents(institutionId, from, to)) {
    const s = sections.get(e.classSectionId);
    if (!ASSESSMENT_TYPES.has(e.type) || e.status === 'cancelled' || !keep(s)) continue;
    out.push({
      id: e.id,
      source: 'calendar',
      status: 'published',
      type: e.type,
      title: e.title,
      date: e.eventDate,
      time: e.eventTime,
      isOfficial: e.isOfficial,
      ...describe(s),
    });
  }
  if (filter.includePending) {
    const pending = await Promise.all(
      [...sections.values()]
        .filter(keep)
        .map(async (s) => ({ s, events: await up.events.listForSection(s.classSectionId) })),
    );
    for (const { s, events } of pending) {
      for (const e of events) {
        if (!e.eventDate || e.eventDate < from || e.eventDate > to) continue;
        if (
          !ASSESSMENT_TYPES.has(e.type) ||
          !PENDING_STATUSES.has(e.confirmationStatus) ||
          e.duplicateOf ||
          e.calendarEventId
        )
          continue;
        out.push({
          id: e.id,
          source: 'event_extraction',
          status: 'awaiting_review',
          type: e.type,
          title: e.title,
          date: e.eventDate,
          time: e.eventTime,
          isOfficial: false,
          ...describe(s),
        });
      }
    }
  }
  out.sort((a, b) =>
    a.date === b.date ? ((a.time ?? '') < (b.time ?? '') ? -1 : 1) : a.date < b.date ? -1 : 1,
  );
  return { assessments: out, sections };
}

export async function assessmentCalendar(
  assessments: readonly Assessment[],
  directory: Directory,
): Promise<{ days: unknown[]; totals: Record<string, number> }> {
  const byDay = new Map<string, Assessment[]>();
  for (const a of assessments) byDay.set(a.date, [...(byDay.get(a.date) ?? []), a]);
  const enrolled = new Map<string, number>();
  for (const a of assessments) {
    if (!enrolled.has(a.classSectionId))
      enrolled.set(a.classSectionId, (await directory.students(a.classSectionId)).size);
  }
  const days = [...byDay.entries()].map(([date, items]) => ({
    date,
    load: items.length,
    sectionsWithAssessments: new Set(items.map((i) => i.classSectionId)).size,
    published: items.filter((i) => i.status === 'published').length,
    awaitingReview: items.filter((i) => i.status === 'awaiting_review').length,
    items: items.map((i) => ({
      ...i,
      enrolledStudents: countOrSuppressed(enrolled.get(i.classSectionId) ?? 0),
    })),
  }));
  return {
    days,
    totals: {
      assessments: assessments.length,
      published: assessments.filter((a) => a.status === 'published').length,
      awaitingReview: assessments.filter((a) => a.status === 'awaiting_review').length,
      days: days.length,
      maxDailyLoad: Math.max(0, ...days.map((d) => d.load)),
    },
  };
}

export interface AssessmentConflict {
  kind: 'assessment_overlap_shared_students' | 'assessment_load' | 'same_day_same_program';
  severity: 'info' | 'warning' | 'blocking';
  date: string;
  windowEnd?: string;
  message: string;
  assessments: {
    id: string;
    type: string;
    title: string;
    date: string;
    classSectionId: string;
    courseCode: string | null;
    status: string;
  }[];
  affectedSections: string[];
  /** Aggregated student count; null + suppressed when fewer than 5 students. */
  students: { count: number | null; suppressed: boolean };
  includesPendingReview: boolean;
}

const brief = (a: Assessment): AssessmentConflict['assessments'][number] => ({
  id: a.id,
  type: a.type,
  title: a.title,
  date: a.date,
  classSectionId: a.classSectionId,
  courseCode: a.courseCode,
  status: a.status,
});

/** Cross-course conflicts (4.4). Student identities never leave this function — only counts. */
export async function detectConflicts(
  assessments: readonly Assessment[],
  directory: Directory,
): Promise<AssessmentConflict[]> {
  const students = new Map<string, ReadonlySet<string>>();
  for (const a of assessments) {
    if (!students.has(a.classSectionId))
      students.set(a.classSectionId, await directory.students(a.classSectionId));
  }
  const conflicts: AssessmentConflict[] = [];
  const byDay = new Map<string, Assessment[]>();
  for (const a of assessments) byDay.set(a.date, [...(byDay.get(a.date) ?? []), a]);

  for (const [date, items] of byDay) {
    // 1. Shared students between different sections on the same day.
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        if (!a || !b || a.classSectionId === b.classSectionId) continue;
        const sa = students.get(a.classSectionId) ?? new Set<string>();
        const sb = students.get(b.classSectionId) ?? new Set<string>();
        let shared = 0;
        for (const s of sa) if (sb.has(s)) shared++;
        if (shared === 0) continue;
        const bothExams = a.type === 'examination' && b.type === 'examination';
        conflicts.push({
          kind: 'assessment_overlap_shared_students',
          severity: bothExams ? 'blocking' : 'warning',
          date,
          message: `${a.courseCode ?? a.courseName ?? 'Disciplina'} e ${b.courseCode ?? b.courseName ?? 'disciplina'} têm avaliações no mesmo dia com alunos em comum`,
          assessments: [brief(a), brief(b)],
          affectedSections: [a.classSectionId, b.classSectionId],
          students: countOrSuppressed(shared),
          includesPendingReview: a.status !== 'published' || b.status !== 'published',
        });
      }
    }
    // 3. Several courses of the same program assess on the same day (no student data needed).
    const byProgram = new Map<string, Assessment[]>();
    for (const a of items)
      if (a.programId) byProgram.set(a.programId, [...(byProgram.get(a.programId) ?? []), a]);
    for (const group of byProgram.values()) {
      const courses = new Set(group.map((g) => g.courseId));
      if (courses.size < 2) continue;
      const sectionIds = [...new Set(group.map((g) => g.classSectionId))];
      const union = new Set<string>();
      for (const id of sectionIds) for (const s of students.get(id) ?? []) union.add(s);
      conflicts.push({
        kind: 'same_day_same_program',
        severity: 'info',
        date,
        message: `${courses.size} disciplinas do mesmo programa têm avaliações neste dia`,
        assessments: group.map(brief),
        affectedSections: sectionIds,
        students: countOrSuppressed(union.size),
        includesPendingReview: group.some((g) => g.status !== 'published'),
      });
    }
  }

  // 2. Assessment load: students with ≥ 3 assessments within 7 days.
  const perStudent = new Map<string, Assessment[]>();
  for (const a of assessments) {
    for (const s of students.get(a.classSectionId) ?? [])
      perStudent.set(s, [...(perStudent.get(s) ?? []), a]);
  }
  const windows = new Map<
    string,
    { students: Set<string>; assessments: Map<string, Assessment> }
  >();
  for (const [student, list] of perStudent) {
    const sorted = [...list].sort((x, y) => (x.date < y.date ? -1 : 1));
    for (let i = 0; i < sorted.length; i++) {
      const start = sorted[i];
      if (!start) continue;
      const end = addDays(start.date, LOAD_WINDOW_DAYS - 1);
      const inWindow = sorted.filter((x) => x.date >= start.date && x.date <= end);
      if (inWindow.length < LOAD_THRESHOLD) continue;
      let w = windows.get(start.date);
      if (!w) windows.set(start.date, (w = { students: new Set(), assessments: new Map() }));
      w.students.add(student);
      for (const x of inWindow) w.assessments.set(x.id, x);
      break; // one window per student: the earliest overload
    }
  }
  for (const [date, w] of [...windows.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const list = [...w.assessments.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    conflicts.push({
      kind: 'assessment_load',
      severity: w.students.size >= MIN_COHORT ? 'warning' : 'info',
      date,
      windowEnd: addDays(date, LOAD_WINDOW_DAYS - 1),
      message: `Alunos com ${LOAD_THRESHOLD} ou mais avaliações em ${LOAD_WINDOW_DAYS} dias`,
      assessments: list.map(brief),
      affectedSections: [...new Set(list.map((a) => a.classSectionId))],
      students: countOrSuppressed(w.students.size),
      includesPendingReview: list.some((a) => a.status !== 'published'),
    });
  }
  const order = { blocking: 0, warning: 1, info: 2 } as const;
  return conflicts.sort((a, b) =>
    a.date === b.date ? order[a.severity] - order[b.severity] : a.date < b.date ? -1 : 1,
  );
}
