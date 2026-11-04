/** Accumulates connector output into a canonical import, deduplicating and collecting warnings. */
import type { ImportIssue } from '../domain.js';
import type { ImportPayloadInput } from '../schemas.js';
import { isEmail } from './http.js';
import { issue, type CanonicalImport } from './types.js';

type Section = ImportPayloadInput['classSections'] extends (infer S)[] | undefined ? S : never;
type Slot = Section['schedule'][number];
type Course = NonNullable<ImportPayloadInput['courses']>[number];
type Enrollment = NonNullable<ImportPayloadInput['enrollments']>[number];
type EnrollmentStatus = NonNullable<Enrollment['status']>;

const MAX_WARNINGS = 500;

export class CanonicalBuilder {
  private readonly courses = new Map<string, Course>();
  private readonly professors = new Map<string, { externalId: string; name: string; email: string }>();
  private readonly students = new Map<string, { externalId: string; name: string; email: string }>();
  private readonly sections = new Map<string, Section>();
  private readonly enrollments = new Map<string, Enrollment>();
  private readonly issues: ImportIssue[] = [];
  private suppressed = 0;
  partial = false;

  warn(path: string, code: string, message: string): void {
    if (this.issues.length < MAX_WARNINGS) this.issues.push(issue(path, code, message));
    else this.suppressed++;
  }

  /** An upstream item could not be fetched: the run is partial. */
  failed(path: string, message: string): void {
    this.partial = true;
    this.warn(path, 'connector.fetch_failed', message);
  }

  get warnings(): ImportIssue[] {
    return this.suppressed > 0
      ? [
          ...this.issues,
          issue('(connector)', 'connector.warnings_truncated', `${this.suppressed} more warnings not shown`),
        ]
      : this.issues;
  }

  addCourse(c: Course): void {
    if (!this.courses.has(c.externalId)) this.courses.set(c.externalId, c);
  }

  hasCourse(externalId: string): boolean {
    return this.courses.has(externalId);
  }

  private person(
    target: Map<string, { externalId: string; name: string; email: string }>,
    path: string,
    p: { externalId: string | undefined; name: string | undefined; email: string | undefined },
  ): string | null {
    if (!p.externalId) {
      this.warn(path, 'connector.missing_id', 'person has no SIS identifier; skipped');
      return null;
    }
    if (!isEmail(p.email)) {
      this.warn(path, 'connector.missing_email', `person ${p.externalId} has no valid e-mail; skipped`);
      return null;
    }
    if (!target.has(p.externalId))
      target.set(p.externalId, { externalId: p.externalId, name: p.name ?? p.externalId, email: p.email });
    return p.externalId;
  }

  addProfessor(path: string, p: { externalId: string | undefined; name: string | undefined; email: string | undefined }): string | null {
    return this.person(this.professors, path, p);
  }

  addStudent(path: string, p: { externalId: string | undefined; name: string | undefined; email: string | undefined }): string | null {
    return this.person(this.students, path, p);
  }

  hasProfessor(externalId: string): boolean {
    return this.professors.has(externalId);
  }

  hasStudent(externalId: string): boolean {
    return this.students.has(externalId);
  }

  /** Adds a section if it is complete enough to import (course, professor, at least one slot). */
  addSection(path: string, s: Omit<Section, 'schedule'> & { schedule: Slot[] }): boolean {
    if (!this.courses.has(s.courseExternalId)) {
      this.warn(path, 'connector.unknown_course', `section ${s.externalId}: course ${s.courseExternalId} not found; skipped`);
      return false;
    }
    if (!this.professors.has(s.professorExternalId)) {
      this.warn(path, 'connector.missing_professor', `section ${s.externalId} has no usable professor; skipped`);
      return false;
    }
    if (s.schedule.length === 0) {
      this.warn(path, 'connector.no_schedule', `section ${s.externalId} has no mapped weekly schedule; skipped`);
      return false;
    }
    const seen = new Set<string>();
    const schedule = s.schedule.filter((slot) => {
      const k = `${slot.dayOfWeek}|${slot.startTime}|${slot.classroomId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    this.sections.set(s.externalId, { ...s, schedule: schedule.slice(0, 20) });
    return true;
  }

  hasSection(externalId: string): boolean {
    return this.sections.has(externalId);
  }

  addEnrollment(studentExternalId: string, classSectionExternalId: string, status: EnrollmentStatus): void {
    const key = `${studentExternalId}|${classSectionExternalId}`;
    const prev = this.enrollments.get(key);
    // An active registration wins over a stale withdrawn/completed duplicate.
    if (!prev || status === 'active')
      this.enrollments.set(key, { studentExternalId, classSectionExternalId, status });
  }

  build(extra: { term?: ImportPayloadInput['term']; timezone?: string | undefined } = {}): CanonicalImport {
    return {
      ...(extra.term ? { term: extra.term } : {}),
      ...(extra.timezone ? { timezone: extra.timezone } : {}),
      courses: [...this.courses.values()],
      professors: [...this.professors.values()],
      students: [...this.students.values()],
      classSections: [...this.sections.values()],
      enrollments: [...this.enrollments.values()],
    };
  }
}

const TIME_FMT = new Map<string, Intl.DateTimeFormat>();

/** `HH:mm` of an instant in `timeZone` (Ethos instructional events carry full date-times). */
export function localTime(instant: string, timeZone: string): string | null {
  const t = Date.parse(instant);
  if (Number.isNaN(t)) return null;
  let fmt = TIME_FMT.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    TIME_FMT.set(timeZone, fmt);
  }
  return fmt.format(new Date(t));
}

/** `HH:mm` from `19:00`, `19:00:00`, `1900` or `19h00`. */
export function hhmm(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{1,2})[:h]?(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** ISO date (`YYYY-MM-DD`) from a date or date-time string. */
export function isoDate(value: string | undefined): string | undefined {
  const m = value ? /^(\d{4}-\d{2}-\d{2})/.exec(value) : null;
  return m?.[1];
}

export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
