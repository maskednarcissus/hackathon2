import type {
  AcademicTerm,
  CalendarEvent,
  CalendarEventChange,
  NonTeachingDay,
  SectionRecord,
} from './domain.js';

export interface EventFilter {
  institutionId?: string;
  courseId?: string;
  classSectionId?: string;
  classSectionIds?: readonly string[];
  from?: string;
  to?: string;
  includeCancelled?: boolean;
}

export interface CalendarRepository {
  insertEvent(event: CalendarEvent): Promise<void>;
  updateEvent(event: CalendarEvent): Promise<void>;
  getEvent(id: string): Promise<CalendarEvent | undefined>;
  findByExtractedEventId(extractedEventId: string): Promise<CalendarEvent | undefined>;
  listEvents(filter: EventFilter): Promise<CalendarEvent[]>;
  appendChanges(changes: readonly CalendarEventChange[]): Promise<void>;
  listChanges(calendarEventId: string): Promise<CalendarEventChange[]>;

  upsertSection(section: SectionRecord): Promise<void>;
  getSection(classSectionId: string): Promise<SectionRecord | undefined>;
  replaceEnrollments(classSectionId: string, studentIds: readonly string[]): Promise<void>;
  addEnrollments(classSectionId: string, studentIds: readonly string[]): Promise<void>;
  studentsOf(classSectionId: string): Promise<ReadonlySet<string>>;
  sectionsOfStudent(studentId: string): Promise<string[]>;
  /** All sections of an institution with their enrolled students. */
  enrollmentsByInstitution(institutionId: string): Promise<Map<string, ReadonlySet<string>>>;

  upsertNonTeachingDays(days: readonly NonTeachingDay[]): Promise<void>;
  getNonTeachingDay(institutionId: string, date: string): Promise<NonTeachingDay | undefined>;
  listNonTeachingDays(institutionId: string): Promise<NonTeachingDay[]>;

  upsertTerm(term: AcademicTerm): Promise<void>;
  listTerms(institutionId: string): Promise<AcademicTerm[]>;
}

const byDate = (a: CalendarEvent, b: CalendarEvent): number =>
  a.eventDate.localeCompare(b.eventDate) ||
  (a.eventTime ?? '').localeCompare(b.eventTime ?? '') ||
  a.createdAt.localeCompare(b.createdAt);

export class InMemoryCalendarRepository implements CalendarRepository {
  private readonly events = new Map<string, CalendarEvent>();
  private readonly changes: CalendarEventChange[] = [];
  private readonly sections = new Map<string, SectionRecord>();
  private readonly enrollments = new Map<string, Set<string>>();
  private readonly nonTeaching = new Map<string, NonTeachingDay>();
  private readonly terms = new Map<string, AcademicTerm>();

  async insertEvent(event: CalendarEvent): Promise<void> {
    this.events.set(event.id, { ...event });
  }

  async updateEvent(event: CalendarEvent): Promise<void> {
    this.events.set(event.id, { ...event });
  }

  async getEvent(id: string): Promise<CalendarEvent | undefined> {
    const e = this.events.get(id);
    return e ? { ...e } : undefined;
  }

  async findByExtractedEventId(extractedEventId: string): Promise<CalendarEvent | undefined> {
    for (const e of this.events.values()) {
      if (e.extractedEventId === extractedEventId) return { ...e };
    }
    return undefined;
  }

  async listEvents(f: EventFilter): Promise<CalendarEvent[]> {
    const sectionSet = f.classSectionIds ? new Set(f.classSectionIds) : undefined;
    return [...this.events.values()]
      .filter(
        (e) =>
          (f.institutionId === undefined || e.institutionId === f.institutionId) &&
          (f.courseId === undefined || e.courseId === f.courseId) &&
          (f.classSectionId === undefined || e.classSectionId === f.classSectionId) &&
          (sectionSet === undefined || sectionSet.has(e.classSectionId)) &&
          (f.from === undefined || e.eventDate >= f.from) &&
          (f.to === undefined || e.eventDate <= f.to) &&
          (f.includeCancelled === true || e.status !== 'cancelled'),
      )
      .sort(byDate)
      .map((e) => ({ ...e }));
  }

  async appendChanges(changes: readonly CalendarEventChange[]): Promise<void> {
    this.changes.push(...changes.map((c) => ({ ...c })));
  }

  async listChanges(calendarEventId: string): Promise<CalendarEventChange[]> {
    // stable sort keeps insertion order for changes recorded in the same instant
    return this.changes
      .filter((c) => c.calendarEventId === calendarEventId)
      .map((c) => ({ ...c }))
      .sort((a, b) => a.changedAt.localeCompare(b.changedAt));
  }

  async upsertSection(section: SectionRecord): Promise<void> {
    this.sections.set(section.classSectionId, { ...section });
  }

  async getSection(classSectionId: string): Promise<SectionRecord | undefined> {
    const s = this.sections.get(classSectionId);
    return s ? { ...s } : undefined;
  }

  async replaceEnrollments(classSectionId: string, studentIds: readonly string[]): Promise<void> {
    this.enrollments.set(classSectionId, new Set(studentIds));
  }

  async addEnrollments(classSectionId: string, studentIds: readonly string[]): Promise<void> {
    const set = this.enrollments.get(classSectionId) ?? new Set<string>();
    for (const id of studentIds) set.add(id);
    this.enrollments.set(classSectionId, set);
  }

  async studentsOf(classSectionId: string): Promise<ReadonlySet<string>> {
    return new Set(this.enrollments.get(classSectionId) ?? []);
  }

  async sectionsOfStudent(studentId: string): Promise<string[]> {
    return [...this.enrollments.entries()]
      .filter(([, students]) => students.has(studentId))
      .map(([sectionId]) => sectionId);
  }

  async enrollmentsByInstitution(institutionId: string): Promise<Map<string, ReadonlySet<string>>> {
    const out = new Map<string, ReadonlySet<string>>();
    for (const [sectionId, students] of this.enrollments) {
      const section = this.sections.get(sectionId);
      if (section?.institutionId === institutionId) out.set(sectionId, new Set(students));
    }
    return out;
  }

  async upsertNonTeachingDays(days: readonly NonTeachingDay[]): Promise<void> {
    for (const d of days) this.nonTeaching.set(`${d.institutionId}|${d.date}`, { ...d });
  }

  async getNonTeachingDay(
    institutionId: string,
    date: string,
  ): Promise<NonTeachingDay | undefined> {
    const d = this.nonTeaching.get(`${institutionId}|${date}`);
    return d ? { ...d } : undefined;
  }

  async listNonTeachingDays(institutionId: string): Promise<NonTeachingDay[]> {
    return [...this.nonTeaching.values()]
      .filter((d) => d.institutionId === institutionId)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async upsertTerm(term: AcademicTerm): Promise<void> {
    this.terms.set(term.id, { ...term });
  }

  async listTerms(institutionId: string): Promise<AcademicTerm[]> {
    return [...this.terms.values()].filter((t) => t.institutionId === institutionId);
  }
}
