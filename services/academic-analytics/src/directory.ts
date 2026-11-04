import { z } from 'zod';

/**
 * Local mirror of the academic structure, fed by academic-integration through the sync endpoints
 * (same pattern as calendar `POST /v1/sections` / `POST /v1/enrollments/bulk`, because
 * academic-integration exposes no per-institution listing). Student ids are pseudonymous and are
 * only ever used to compute aggregate counts.
 */

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const SectionSyncSchema = z.object({
  sections: z
    .array(
      z.object({
        classSectionId: uuid,
        institutionId: uuid,
        courseId: uuid,
        courseCode: z.string().max(50).optional(),
        courseName: z.string().max(255).optional(),
        programId: uuid.optional(),
        programName: z.string().max(255).optional(),
        professorId: uuid.optional(),
        professorName: z.string().max(255).optional(),
        sectionCode: z.string().max(50).optional(),
        termStartDate: date.optional(),
        termEndDate: date.optional(),
      }),
    )
    .min(1)
    .max(5000),
});

export const EnrollmentSyncSchema = z.object({
  classSectionId: uuid,
  studentIds: z.array(uuid).max(5000),
  mode: z.enum(['replace', 'append']).default('replace'),
});

export const ClassroomSyncSchema = z.object({
  classrooms: z
    .array(
      z.object({
        classroomId: uuid,
        institutionId: uuid,
        campusId: uuid,
        campusName: z.string().max(255).optional(),
        name: z.string().max(255).optional(),
      }),
    )
    .min(1)
    .max(5000),
});

export interface Section {
  classSectionId: string;
  institutionId: string;
  courseId: string;
  courseCode: string | null;
  courseName: string | null;
  programId: string | null;
  programName: string | null;
  professorId: string | null;
  professorName: string | null;
  sectionCode: string | null;
  termStartDate: string | null;
  termEndDate: string | null;
}

export interface Classroom {
  classroomId: string;
  institutionId: string;
  campusId: string;
  campusName: string | null;
  name: string | null;
}

export interface Directory {
  upsertSections(sections: Section[]): Promise<void>;
  setEnrollments(
    classSectionId: string,
    studentIds: string[],
    mode: 'replace' | 'append',
  ): Promise<number>;
  upsertClassrooms(classrooms: Classroom[]): Promise<void>;
  sections(institutionId: string): Promise<Section[]>;
  section(classSectionId: string): Promise<Section | null>;
  sectionsOfCourse(courseId: string): Promise<Section[]>;
  students(classSectionId: string): Promise<ReadonlySet<string>>;
  classroom(classroomId: string): Promise<Classroom | null>;
}

export class InMemoryDirectory implements Directory {
  private readonly sectionMap = new Map<string, Section>();
  private readonly enrollments = new Map<string, Set<string>>();
  private readonly classrooms = new Map<string, Classroom>();

  upsertSections(sections: Section[]): Promise<void> {
    for (const s of sections) this.sectionMap.set(s.classSectionId, s);
    return Promise.resolve();
  }
  setEnrollments(
    classSectionId: string,
    studentIds: string[],
    mode: 'replace' | 'append',
  ): Promise<number> {
    const set =
      mode === 'replace'
        ? new Set<string>()
        : (this.enrollments.get(classSectionId) ?? new Set<string>());
    for (const id of studentIds) set.add(id);
    this.enrollments.set(classSectionId, set);
    return Promise.resolve(set.size);
  }
  upsertClassrooms(classrooms: Classroom[]): Promise<void> {
    for (const c of classrooms) this.classrooms.set(c.classroomId, c);
    return Promise.resolve();
  }
  sections(institutionId: string): Promise<Section[]> {
    return Promise.resolve(
      [...this.sectionMap.values()].filter((s) => s.institutionId === institutionId),
    );
  }
  section(classSectionId: string): Promise<Section | null> {
    return Promise.resolve(this.sectionMap.get(classSectionId) ?? null);
  }
  sectionsOfCourse(courseId: string): Promise<Section[]> {
    return Promise.resolve([...this.sectionMap.values()].filter((s) => s.courseId === courseId));
  }
  students(classSectionId: string): Promise<ReadonlySet<string>> {
    return Promise.resolve(this.enrollments.get(classSectionId) ?? new Set<string>());
  }
  classroom(classroomId: string): Promise<Classroom | null> {
    return Promise.resolve(this.classrooms.get(classroomId) ?? null);
  }
}
