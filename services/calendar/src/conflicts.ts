import { addDays } from './dates.js';
import {
  ASSESSMENT_TYPES,
  IN_CLASS_ASSESSMENTS,
  IN_CLASS_TYPES,
  type AcademicEventType,
  type CalendarEvent,
  type Conflict,
  type ConflictSeverity,
} from './domain.js';
import type { CalendarRepository } from './repository.js';

export interface ConflictQuery {
  institutionId: string;
  classSectionId: string;
  type: AcademicEventType;
  eventDate: string;
  eventTime?: string | undefined;
  excludeEventId?: string | undefined;
}

/** Minimum number of assessments within a 7-day window that is considered overload. */
export const ASSESSMENT_LOAD_THRESHOLD = 3;
const LOAD_WINDOW_DAYS = 7;

const severityRank: Record<ConflictSeverity, number> = { blocking: 0, warning: 1, info: 2 };

const formatDate = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

/**
 * Detects conflicts between a candidate event and the existing calendar.
 * Messages never include student identities — only aggregate counts (LGPD).
 */
export async function detectConflicts(
  repo: CalendarRepository,
  q: ConflictQuery,
): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];
  const notSelf = (e: CalendarEvent): boolean => e.id !== q.excludeEventId;

  // 1. Same section, same day
  const sectionEvents = (await repo.listEvents({ classSectionId: q.classSectionId })).filter(
    notSelf,
  );
  for (const e of sectionEvents.filter((ev) => ev.eventDate === q.eventDate)) {
    const sameTime = q.eventTime !== undefined && e.eventTime === q.eventTime;
    const bothInClass = IN_CLASS_ASSESSMENTS.has(q.type) && IN_CLASS_ASSESSMENTS.has(e.type);
    conflicts.push({
      kind: 'same_section_same_day',
      severity: sameTime && bothInClass ? 'blocking' : 'warning',
      message: `A turma já tem "${e.title}" em ${formatDate(e.eventDate)}${
        e.eventTime ? ` às ${e.eventTime}` : ''
      }.`,
      relatedEventId: e.id,
    });
  }

  // 5. Same section and type already scheduled on another date
  for (const e of sectionEvents.filter(
    (ev) => ev.type === q.type && ev.eventDate !== q.eventDate,
  )) {
    conflicts.push({
      kind: 'existing_event_different_date',
      severity: 'warning',
      message: `Já existe "${e.title}" (${e.type}) publicado para ${formatDate(
        e.eventDate,
      )}. Confirme se é um novo evento ou uma mudança de data.`,
      relatedEventId: e.id,
    });
  }

  // 4. Non-teaching day / outside term
  const holiday = await repo.getNonTeachingDay(q.institutionId, q.eventDate);
  const nonTeachingSeverity: ConflictSeverity = IN_CLASS_TYPES.has(q.type) ? 'blocking' : 'warning';
  if (holiday) {
    conflicts.push({
      kind: 'non_teaching_day',
      severity: q.type === 'class_cancellation' ? 'info' : nonTeachingSeverity,
      message: `${formatDate(q.eventDate)} é dia sem aula: ${holiday.description}.`,
    });
  } else {
    const terms = await repo.listTerms(q.institutionId);
    if (
      terms.length > 0 &&
      !terms.some((t) => q.eventDate >= t.startDate && q.eventDate <= t.endDate)
    ) {
      conflicts.push({
        kind: 'non_teaching_day',
        severity: nonTeachingSeverity,
        message: `${formatDate(q.eventDate)} está fora do período letivo.`,
      });
    }
  }

  // 2 & 3 need enrollment data
  if (ASSESSMENT_TYPES.has(q.type)) {
    const students = await repo.studentsOf(q.classSectionId);
    if (students.size > 0) {
      const enrollments = await repo.enrollmentsByInstitution(q.institutionId);
      const otherSections = new Map<string, number>(); // sectionId -> shared student count
      for (const [sectionId, members] of enrollments) {
        if (sectionId === q.classSectionId) continue;
        let shared = 0;
        for (const s of members) if (students.has(s)) shared += 1;
        if (shared > 0) otherSections.set(sectionId, shared);
      }

      const windowStart = addDays(q.eventDate, -(LOAD_WINDOW_DAYS - 1));
      const windowEnd = addDays(q.eventDate, LOAD_WINDOW_DAYS - 1);
      const nearby =
        otherSections.size === 0
          ? []
          : (
              await repo.listEvents({
                institutionId: q.institutionId,
                classSectionIds: [...otherSections.keys(), q.classSectionId],
                from: windowStart,
                to: windowEnd,
              })
            ).filter((e) => notSelf(e) && ASSESSMENT_TYPES.has(e.type));

      // 2. In-class assessment on the same day in a section sharing students
      if (IN_CLASS_ASSESSMENTS.has(q.type)) {
        for (const e of nearby) {
          const shared = otherSections.get(e.classSectionId);
          if (shared === undefined || e.eventDate !== q.eventDate) continue;
          if (!IN_CLASS_ASSESSMENTS.has(e.type)) continue;
          conflicts.push({
            kind: 'assessment_overlap_shared_students',
            severity: 'warning',
            message: `${shared} aluno(s) desta turma também têm "${e.title}" em outra disciplina no mesmo dia.`,
            relatedEventId: e.id,
          });
        }
      }

      // 3. Assessment load: any 7-day window containing the date with >= threshold assessments
      const eventsBySection = new Map<string, CalendarEvent[]>();
      for (const e of nearby) {
        const list = eventsBySection.get(e.classSectionId) ?? [];
        list.push(e);
        eventsBySection.set(e.classSectionId, list);
      }
      let overloaded = 0;
      let worst = 0;
      for (const student of students) {
        const dates: string[] = [q.eventDate];
        for (const [sectionId, events] of eventsBySection) {
          const inSection =
            sectionId === q.classSectionId || enrollments.get(sectionId)?.has(student) === true;
          if (inSection) dates.push(...events.map((e) => e.eventDate));
        }
        let maxInWindow = 0;
        for (let offset = -(LOAD_WINDOW_DAYS - 1); offset <= 0; offset += 1) {
          const start = addDays(q.eventDate, offset);
          const end = addDays(start, LOAD_WINDOW_DAYS - 1);
          const count = dates.filter((d) => d >= start && d <= end).length;
          maxInWindow = Math.max(maxInWindow, count);
        }
        if (maxInWindow >= ASSESSMENT_LOAD_THRESHOLD) {
          overloaded += 1;
          worst = Math.max(worst, maxInWindow);
        }
      }
      if (overloaded > 0) {
        conflicts.push({
          kind: 'assessment_load',
          severity: 'warning',
          message: `${overloaded} aluno(s) teriam até ${worst} avaliações em 7 dias.`,
        });
      }
    }
  }

  return conflicts.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
}
