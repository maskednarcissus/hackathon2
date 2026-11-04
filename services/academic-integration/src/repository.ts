import type {
  ClassSection,
  Course,
  Enrollment,
  ImportReport,
  Person,
  ScheduledClass,
  Term,
} from './domain.js';

/** Current state of one institution, indexed by external ID (scheduled classes by `${sectionId}|${key}`). */
export interface InstitutionSnapshot {
  terms: Map<string, Term>;
  courses: Map<string, Course>;
  professors: Map<string, Person>;
  students: Map<string, Person>;
  classSections: Map<string, ClassSection>;
  /** keyed by `${studentId}|${classSectionId}` */
  enrollments: Map<string, Enrollment>;
  scheduledClasses: Map<string, ScheduledClass>;
}

export interface ChangeSet {
  terms: Term[];
  courses: Course[];
  professors: Person[];
  students: Person[];
  classSections: ClassSection[];
  enrollments: Enrollment[];
  scheduledClasses: ScheduledClass[];
}

export interface ScheduledClassQuery {
  classroomId?: string;
  classSectionId?: string;
  /** Classes ending after `from`. */
  from?: string;
  /** Classes starting before `to`. */
  to?: string;
  includeCancelled?: boolean;
}

export interface AcademicRepository {
  snapshot(institutionId: string): Promise<InstitutionSnapshot>;
  /** Applies all upserts in a single transaction. */
  apply(changes: ChangeSet): Promise<void>;
  saveImportReport(report: ImportReport): Promise<void>;
  getImportReport(id: string): Promise<ImportReport | null>;
  findScheduledClasses(q: ScheduledClassQuery): Promise<ScheduledClass[]>;
  getScheduledClass(id: string): Promise<ScheduledClass | null>;
  getClassSection(id: string): Promise<ClassSection | null>;
  getCourse(id: string): Promise<Course | null>;
  getProfessor(id: string): Promise<Person | null>;
  getTerm(id: string): Promise<Term | null>;
}

export const scheduledClassKey = (s: Pick<ScheduledClass, 'classSectionId' | 'key'>): string =>
  `${s.classSectionId}|${s.key}`;
export const enrollmentKey = (e: Pick<Enrollment, 'studentId' | 'classSectionId'>): string =>
  `${e.studentId}|${e.classSectionId}`;

export class InMemoryAcademicRepository implements AcademicRepository {
  private readonly terms = new Map<string, Term>();
  private readonly courses = new Map<string, Course>();
  private readonly professors = new Map<string, Person>();
  private readonly students = new Map<string, Person>();
  private readonly sections = new Map<string, ClassSection>();
  private readonly enrollments = new Map<string, Enrollment>();
  private readonly scheduled = new Map<string, ScheduledClass>();
  private readonly reports = new Map<string, ImportReport>();

  snapshot(institutionId: string): Promise<InstitutionSnapshot> {
    const byExt = <T extends { institutionId: string; externalId: string }>(
      m: Map<string, T>,
    ): Map<string, T> =>
      new Map(
        [...m.values()]
          .filter((v) => v.institutionId === institutionId)
          .map((v) => [v.externalId, v]),
      );
    return Promise.resolve({
      terms: byExt(this.terms),
      courses: byExt(this.courses),
      professors: byExt(this.professors),
      students: byExt(this.students),
      classSections: byExt(this.sections),
      enrollments: new Map(
        [...this.enrollments.values()]
          .filter((e) => e.institutionId === institutionId)
          .map((e) => [enrollmentKey(e), e]),
      ),
      scheduledClasses: new Map(
        [...this.scheduled.values()]
          .filter((s) => s.institutionId === institutionId)
          .map((s) => [scheduledClassKey(s), s]),
      ),
    });
  }

  apply(c: ChangeSet): Promise<void> {
    for (const t of c.terms) this.terms.set(t.id, t);
    for (const x of c.courses) this.courses.set(x.id, x);
    for (const x of c.professors) this.professors.set(x.id, x);
    for (const x of c.students) this.students.set(x.id, x);
    for (const x of c.classSections) this.sections.set(x.id, x);
    for (const x of c.enrollments) this.enrollments.set(x.id, x);
    for (const x of c.scheduledClasses) this.scheduled.set(x.id, x);
    return Promise.resolve();
  }

  saveImportReport(report: ImportReport): Promise<void> {
    this.reports.set(report.importId, report);
    return Promise.resolve();
  }

  getImportReport(id: string): Promise<ImportReport | null> {
    return Promise.resolve(this.reports.get(id) ?? null);
  }

  findScheduledClasses(q: ScheduledClassQuery): Promise<ScheduledClass[]> {
    return Promise.resolve(
      [...this.scheduled.values()]
        .filter(
          (s) =>
            (q.classroomId === undefined || s.classroomId === q.classroomId) &&
            (q.classSectionId === undefined || s.classSectionId === q.classSectionId) &&
            (q.from === undefined || s.endsAt > q.from) &&
            (q.to === undefined || s.startsAt < q.to) &&
            (q.includeCancelled === true || s.status !== 'cancelled'),
        )
        .sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0)),
    );
  }

  getScheduledClass(id: string): Promise<ScheduledClass | null> {
    return Promise.resolve(this.scheduled.get(id) ?? null);
  }
  getClassSection(id: string): Promise<ClassSection | null> {
    return Promise.resolve(this.sections.get(id) ?? null);
  }
  getCourse(id: string): Promise<Course | null> {
    return Promise.resolve(this.courses.get(id) ?? null);
  }
  getProfessor(id: string): Promise<Person | null> {
    return Promise.resolve(this.professors.get(id) ?? null);
  }
  getTerm(id: string): Promise<Term | null> {
    return Promise.resolve(this.terms.get(id) ?? null);
  }
}
