import type {
  ClassSection,
  Course,
  Enrollment,
  EntityCounts,
  ImportIssue,
  ImportReport,
  Person,
  ScheduleException,
  ScheduledClass,
  Term,
} from './domain.js';
import {
  enrollmentKey,
  scheduledClassKey,
  type ChangeSet,
  type InstitutionSnapshot,
} from './repository.js';
import { expandSection } from './schedule.js';
import type { ImportPayload } from './schemas.js';
import { zonedTimeToUtc } from './tz.js';

export interface ImportPlan {
  errors: ImportIssue[];
  warnings: ImportIssue[];
  counts: ImportReport['counts'];
  changes: ChangeSet;
}

const emptyCounts = (): EntityCounts => ({ created: 0, updated: 0, unchanged: 0 });

function sameExceptId<T extends { id: string }>(a: T, b: T): boolean {
  return JSON.stringify({ ...a, id: null }) === JSON.stringify({ ...b, id: null });
}

/**
 * Validates an import against the institution's current state and computes the upserts.
 * Pure function: nothing is persisted. Import is all-or-nothing; any error rejects the whole payload.
 */
export function planImport(
  p: ImportPayload,
  snap: InstitutionSnapshot,
  newId: () => string,
): ImportPlan {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const counts: ImportReport['counts'] = {
    terms: emptyCounts(),
    courses: emptyCounts(),
    professors: emptyCounts(),
    students: emptyCounts(),
    classSections: emptyCounts(),
    enrollments: emptyCounts(),
    scheduledClasses: emptyCounts(),
    scheduledClassesCancelled: 0,
  };
  const changes: ChangeSet = {
    terms: [],
    courses: [],
    professors: [],
    students: [],
    classSections: [],
    enrollments: [],
    scheduledClasses: [],
  };

  function track<T extends { id: string }>(
    entity: Omit<T, 'id'>,
    existing: T | undefined,
    bucket: T[],
    c: EntityCounts,
  ): T {
    const next = { ...entity, id: existing?.id ?? newId() } as T;
    if (!existing) {
      c.created++;
      bucket.push(next);
    } else if (!sameExceptId(existing, next)) {
      c.updated++;
      bucket.push(next);
    } else {
      c.unchanged++;
    }
    return next;
  }

  function duplicates(items: readonly { externalId: string }[], path: string): void {
    const seen = new Map<string, number>();
    items.forEach((item, i) => {
      const prev = seen.get(item.externalId);
      if (prev !== undefined) {
        errors.push({
          path: `${path}[${i}].externalId`,
          code: 'duplicate_external_id',
          message: `externalId "${item.externalId}" already used at ${path}[${prev}]`,
        });
      } else seen.set(item.externalId, i);
    });
  }
  duplicates(p.courses, 'courses');
  duplicates(p.professors, 'professors');
  duplicates(p.students, 'students');
  duplicates(p.classSections, 'classSections');

  const inst = p.institutionId;
  const term = track<Term>(
    {
      institutionId: inst,
      externalId: p.term.externalId,
      name: p.term.name,
      startDate: p.term.startDate,
      endDate: p.term.endDate,
      timezone: p.timezone,
    },
    snap.terms.get(p.term.externalId),
    changes.terms,
    counts.terms,
  );

  const courses = new Map(snap.courses);
  for (const c of p.courses) {
    const existing = snap.courses.get(c.externalId);
    courses.set(
      c.externalId,
      track<Course>(
        {
          institutionId: inst,
          academicTermId: term.id,
          externalId: c.externalId,
          code: c.code,
          name: c.name,
          discipline: c.discipline,
          credits: c.credits ?? null,
        },
        existing,
        changes.courses,
        counts.courses,
      ),
    );
  }

  const people = (
    input: ImportPayload['professors'],
    current: Map<string, Person>,
    bucket: Person[],
    c: EntityCounts,
  ): Map<string, Person> => {
    const result = new Map(current);
    for (const x of input) {
      result.set(
        x.externalId,
        track<Person>(
          { institutionId: inst, externalId: x.externalId, name: x.name, email: x.email },
          current.get(x.externalId),
          bucket,
          c,
        ),
      );
    }
    return result;
  };
  const professors = people(p.professors, snap.professors, changes.professors, counts.professors);
  const students = people(p.students, snap.students, changes.students, counts.students);

  const sections = new Map(snap.classSections);
  p.classSections.forEach((s, i) => {
    const path = `classSections[${i}]`;
    const course = courses.get(s.courseExternalId);
    const professor = professors.get(s.professorExternalId);
    if (!course)
      errors.push({
        path: `${path}.courseExternalId`,
        code: 'unknown_reference',
        message: `course "${s.courseExternalId}" not found in payload or existing data`,
      });
    else if (course.academicTermId !== term.id)
      errors.push({
        path: `${path}.courseExternalId`,
        code: 'term_mismatch',
        message: `course "${s.courseExternalId}" belongs to another academic term`,
      });
    if (!professor)
      errors.push({
        path: `${path}.professorExternalId`,
        code: 'unknown_reference',
        message: `professor "${s.professorExternalId}" not found in payload or existing data`,
      });

    const exceptions: ScheduleException[] = [
      ...s.exceptions.map((e): ScheduleException => {
        if (e.type === 'cancelled') return { date: e.date, type: 'cancelled', reason: e.reason };
        if (e.type === 'rescheduled')
          return {
            date: e.date,
            type: 'rescheduled',
            startTime: e.startTime,
            endTime: e.endTime,
            classroomId: e.classroomId,
          };
        return {
          date: e.date,
          type: 'extra',
          startTime: e.startTime,
          endTime: e.endTime,
          classroomId: e.classroomId,
        };
      }),
      ...s.cancelledDates.map((date): ScheduleException => ({
        date,
        type: 'cancelled',
        reason: undefined,
      })),
    ];
    exceptions.forEach((e, j) => {
      if (e.date < term.startDate || e.date > term.endDate) {
        errors.push({
          path: `${path}.exceptions[${j}].date`,
          code: 'outside_term',
          message: `date ${e.date} is outside the term ${term.startDate}..${term.endDate}`,
        });
      }
    });
    // overlapping weekly slots for the same section
    s.schedule.forEach((a, j) =>
      s.schedule.forEach((b, k) => {
        if (
          k > j &&
          a.dayOfWeek === b.dayOfWeek &&
          a.startTime < b.endTime &&
          b.startTime < a.endTime
        ) {
          errors.push({
            path: `${path}.schedule[${k}]`,
            code: 'overlapping_slot',
            message: `overlaps schedule[${j}] on day ${a.dayOfWeek}`,
          });
        }
      }),
    );
    if (!course || !professor) return;

    const section = track<ClassSection>(
      {
        institutionId: inst,
        academicTermId: term.id,
        externalId: s.externalId,
        courseId: course.id,
        professorId: professor.id,
        sectionCode: s.sectionCode,
        schedule: s.schedule,
        exceptions,
      },
      snap.classSections.get(s.externalId),
      changes.classSections,
      counts.classSections,
    );
    sections.set(s.externalId, section);

    const planned = expandSection(section, term.startDate, term.endDate);
    if (planned.length === 0)
      warnings.push({
        path,
        code: 'no_sessions',
        message: 'schedule produces no class sessions within the term',
      });
    const plannedKeys = new Set<string>();
    for (const ps of planned) {
      const startsAt = zonedTimeToUtc(ps.localDate, ps.startTime, p.timezone).toISOString();
      const endsAt = zonedTimeToUtc(ps.localDate, ps.endTime, p.timezone).toISOString();
      const k = scheduledClassKey({ classSectionId: section.id, key: ps.key });
      plannedKeys.add(k);
      track<ScheduledClass>(
        {
          institutionId: inst,
          key: ps.key,
          classSectionId: section.id,
          courseId: course.id,
          professorId: professor.id,
          classroomId: ps.classroomId,
          localDate: ps.localDate,
          timezone: p.timezone,
          startsAt,
          endsAt,
          status: ps.status,
          cancellationReason: ps.cancellationReason,
          source: ps.source,
        },
        snap.scheduledClasses.get(k),
        changes.scheduledClasses,
        counts.scheduledClasses,
      );
    }
    // Sessions that disappeared from the timetable are cancelled, never deleted (recordings may reference them).
    for (const [k, existing] of snap.scheduledClasses) {
      if (
        existing.classSectionId === section.id &&
        !plannedKeys.has(k) &&
        existing.status === 'scheduled'
      ) {
        changes.scheduledClasses.push({
          ...existing,
          status: 'cancelled',
          cancellationReason: 'removed_from_timetable',
        });
        counts.scheduledClassesCancelled++;
      }
    }
  });

  const seenEnrollments = new Set<string>();
  p.enrollments.forEach((e, i) => {
    const path = `enrollments[${i}]`;
    const student = students.get(e.studentExternalId);
    const section = sections.get(e.classSectionExternalId);
    if (!student)
      errors.push({
        path: `${path}.studentExternalId`,
        code: 'unknown_reference',
        message: `student "${e.studentExternalId}" not found in payload or existing data`,
      });
    if (!section)
      errors.push({
        path: `${path}.classSectionExternalId`,
        code: 'unknown_reference',
        message: `class section "${e.classSectionExternalId}" not found in payload or existing data`,
      });
    if (!student || !section) return;
    const k = enrollmentKey({ studentId: student.id, classSectionId: section.id });
    if (seenEnrollments.has(k)) {
      errors.push({
        path,
        code: 'duplicate_enrollment',
        message: 'student is enrolled twice in the same section',
      });
      return;
    }
    seenEnrollments.add(k);
    track<Enrollment>(
      { institutionId: inst, studentId: student.id, classSectionId: section.id, status: e.status },
      snap.enrollments.get(k),
      changes.enrollments,
      counts.enrollments,
    );
  });

  return { errors, warnings, counts, changes };
}
