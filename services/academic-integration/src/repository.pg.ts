import type {
  ClassSection,
  Course,
  Enrollment,
  ImportReport,
  Person,
  ScheduledClass,
  ScheduleException,
  Term,
  WeeklySlot,
} from './domain.js';
import { iso, PG, pgCode, withTransaction, type Pool, type PoolClient } from './platform/pg.js';
import {
  DuplicateDataError,
  MissingReferenceError,
  enrollmentKey,
  scheduledClassKey,
  type AcademicRepository,
  type ChangeSet,
  type InstitutionSnapshot,
  type ScheduledClassQuery,
} from './repository.js';

const CHUNK = 2000;

/** Bulk upsert through jsonb_to_recordset (one round trip per chunk). */
async function upsert(
  c: PoolClient,
  table: string,
  columns: Record<string, string>,
  rows: Record<string, unknown>[],
  updateColumns: string[],
): Promise<void> {
  const names = Object.keys(columns);
  const recordType = names.map((n) => `${n} ${columns[n] ?? 'text'}`).join(', ');
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await c.query(
      `INSERT INTO ${table} (${names.join(', ')})
       SELECT ${names.join(', ')} FROM jsonb_to_recordset($1::jsonb) AS x(${recordType})
       ON CONFLICT (id) DO UPDATE SET ${updateColumns.map((col) => `${col} = EXCLUDED.${col}`).join(', ')}, updated_at = NOW()`,
      [JSON.stringify(chunk)],
    );
  }
}

interface ScheduledRow {
  id: string;
  institution_id: string;
  slot_key: string;
  class_section_id: string;
  course_id: string;
  professor_id: string;
  classroom_id: string;
  local_date: string;
  timezone: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
  cancellation_reason: string | null;
  source: 'timetable' | 'exception';
}

const SCHEDULED_SELECT = `
  SELECT sc.id, cs.institution_id, sc.slot_key, sc.class_section_id, cs.course_id, cs.professor_id, sc.classroom_id,
         sc.local_date, sc.timezone, sc.starts_at, sc.ends_at, sc.status, sc.cancellation_reason, sc.source
    FROM scheduled_classes sc JOIN class_sections cs ON cs.id = sc.class_section_id`;

const toScheduled = (r: ScheduledRow): ScheduledClass => ({
  id: r.id,
  institutionId: r.institution_id,
  key: r.slot_key,
  classSectionId: r.class_section_id,
  courseId: r.course_id,
  professorId: r.professor_id,
  classroomId: r.classroom_id,
  localDate: r.local_date,
  timezone: r.timezone,
  startsAt: iso(r.starts_at),
  endsAt: iso(r.ends_at),
  status: r.status === 'cancelled' ? 'cancelled' : 'scheduled',
  cancellationReason: r.cancellation_reason,
  source: r.source,
});

interface SectionRow {
  id: string;
  institution_id: string;
  academic_term_id: string;
  external_id: string;
  course_id: string;
  professor_id: string;
  section_code: string;
  schedule: WeeklySlot[];
  exceptions: ScheduleException[];
}

const toSection = (r: SectionRow): ClassSection => ({
  id: r.id,
  institutionId: r.institution_id,
  academicTermId: r.academic_term_id,
  externalId: r.external_id,
  courseId: r.course_id,
  professorId: r.professor_id,
  sectionCode: r.section_code,
  schedule: r.schedule,
  exceptions: r.exceptions,
});

/**
 * Academic structure on the V001/V002 tables (academic_terms, courses, professors, students,
 * class_sections, enrollments, scheduled_classes, academic_import_runs). Imports are applied in one
 * transaction; classrooms are owned by organization and only referenced.
 */
export class PgAcademicRepository implements AcademicRepository {
  constructor(private readonly pool: Pool) {}

  async snapshot(institutionId: string): Promise<InstitutionSnapshot> {
    const q = <T>(sql: string): Promise<T[]> =>
      this.pool.query(sql, [institutionId]).then((r) => r.rows as T[]);
    const [terms, courses, professors, students, sections, enrollments, scheduled] =
      await Promise.all([
        q<{
          id: string;
          external_id: string;
          name: string;
          start_date: string;
          end_date: string;
          timezone: string;
        }>(
          `SELECT id, external_id, name, start_date, end_date, timezone FROM academic_terms
          WHERE institution_id = $1 AND external_id IS NOT NULL`,
        ),
        q<{
          id: string;
          external_id: string;
          academic_term_id: string;
          code: string;
          name: string;
          discipline: string;
          credits: number | null;
        }>(
          `SELECT id, external_id, academic_term_id, code, name, discipline, credits FROM courses
          WHERE institution_id = $1 AND external_id IS NOT NULL`,
        ),
        q<{ id: string; external_id: string; name: string; email: string }>(
          `SELECT id, external_id, name, email FROM professors WHERE institution_id = $1 AND external_id IS NOT NULL`,
        ),
        q<{ id: string; external_id: string; name: string; email: string }>(
          `SELECT id, external_id, name, email FROM students WHERE institution_id = $1 AND external_id IS NOT NULL`,
        ),
        q<SectionRow>(
          `SELECT id, institution_id, academic_term_id, external_id, course_id, professor_id, section_code, schedule, exceptions
           FROM class_sections WHERE institution_id = $1 AND external_id IS NOT NULL`,
        ),
        q<{
          id: string;
          student_id: string;
          class_section_id: string;
          status: Enrollment['status'];
        }>(
          `SELECT e.id, e.student_id, e.class_section_id, e.status FROM enrollments e
           JOIN class_sections cs ON cs.id = e.class_section_id WHERE cs.institution_id = $1`,
        ),
        q<ScheduledRow>(
          `${SCHEDULED_SELECT} WHERE cs.institution_id = $1 AND sc.slot_key IS NOT NULL`,
        ),
      ]);
    const person = (r: {
      id: string;
      external_id: string;
      name: string;
      email: string;
    }): Person => ({
      id: r.id,
      institutionId,
      externalId: r.external_id,
      name: r.name,
      email: r.email,
    });
    return {
      terms: new Map(
        terms.map((t) => [
          t.external_id,
          {
            id: t.id,
            institutionId,
            externalId: t.external_id,
            name: t.name,
            startDate: t.start_date,
            endDate: t.end_date,
            timezone: t.timezone,
          },
        ]),
      ),
      courses: new Map(
        courses.map((c) => [
          c.external_id,
          {
            id: c.id,
            institutionId,
            academicTermId: c.academic_term_id,
            externalId: c.external_id,
            code: c.code,
            name: c.name,
            discipline: c.discipline,
            credits: c.credits,
          },
        ]),
      ),
      professors: new Map(professors.map((p) => [p.external_id, person(p)])),
      students: new Map(students.map((s) => [s.external_id, person(s)])),
      classSections: new Map(sections.map((s) => [s.external_id, toSection(s)])),
      enrollments: new Map(
        enrollments.map((e) => {
          const en: Enrollment = {
            id: e.id,
            institutionId,
            studentId: e.student_id,
            classSectionId: e.class_section_id,
            status: e.status,
          };
          return [enrollmentKey(en), en];
        }),
      ),
      scheduledClasses: new Map(
        scheduled.map((r) => [
          scheduledClassKey({ classSectionId: r.class_section_id, key: r.slot_key }),
          toScheduled(r),
        ]),
      ),
    };
  }

  async apply(ch: ChangeSet): Promise<void> {
    try {
      await withTransaction(this.pool, async (c) => {
        await upsert(
          c,
          'academic_terms',
          {
            id: 'uuid',
            institution_id: 'uuid',
            external_id: 'text',
            name: 'text',
            start_date: 'date',
            end_date: 'date',
            timezone: 'text',
          },
          ch.terms.map((t: Term) => ({
            id: t.id,
            institution_id: t.institutionId,
            external_id: t.externalId,
            name: t.name,
            start_date: t.startDate,
            end_date: t.endDate,
            timezone: t.timezone,
          })),
          ['name', 'start_date', 'end_date', 'timezone'],
        );
        await upsert(
          c,
          'courses',
          {
            id: 'uuid',
            institution_id: 'uuid',
            academic_term_id: 'uuid',
            external_id: 'text',
            code: 'text',
            name: 'text',
            discipline: 'text',
            credits: 'int',
          },
          ch.courses.map((x: Course) => ({
            id: x.id,
            institution_id: x.institutionId,
            academic_term_id: x.academicTermId,
            external_id: x.externalId,
            code: x.code,
            name: x.name,
            discipline: x.discipline,
            credits: x.credits,
          })),
          ['academic_term_id', 'code', 'name', 'discipline', 'credits'],
        );
        const people = (xs: Person[]): Record<string, unknown>[] =>
          xs.map((p) => ({
            id: p.id,
            institution_id: p.institutionId,
            external_id: p.externalId,
            name: p.name,
            email: p.email,
          }));
        const personCols = {
          id: 'uuid',
          institution_id: 'uuid',
          external_id: 'text',
          name: 'text',
          email: 'text',
        };
        await upsert(c, 'professors', personCols, people(ch.professors), ['name', 'email']);
        await upsert(c, 'students', personCols, people(ch.students), ['name', 'email']);
        await upsert(
          c,
          'class_sections',
          {
            id: 'uuid',
            institution_id: 'uuid',
            academic_term_id: 'uuid',
            external_id: 'text',
            course_id: 'uuid',
            professor_id: 'uuid',
            section_code: 'text',
            schedule: 'jsonb',
            exceptions: 'jsonb',
          },
          ch.classSections.map((s) => ({
            id: s.id,
            institution_id: s.institutionId,
            academic_term_id: s.academicTermId,
            external_id: s.externalId,
            course_id: s.courseId,
            professor_id: s.professorId,
            section_code: s.sectionCode,
            schedule: s.schedule,
            exceptions: s.exceptions,
          })),
          [
            'academic_term_id',
            'course_id',
            'professor_id',
            'section_code',
            'schedule',
            'exceptions',
          ],
        );
        await upsert(
          c,
          'enrollments',
          { id: 'uuid', student_id: 'uuid', class_section_id: 'uuid', status: 'enrollment_status' },
          ch.enrollments.map((e) => ({
            id: e.id,
            student_id: e.studentId,
            class_section_id: e.classSectionId,
            status: e.status,
          })),
          ['status'],
        );
        await upsert(
          c,
          'scheduled_classes',
          {
            id: 'uuid',
            class_section_id: 'uuid',
            classroom_id: 'uuid',
            slot_key: 'text',
            local_date: 'date',
            timezone: 'text',
            starts_at: 'timestamptz',
            ends_at: 'timestamptz',
            status: 'scheduled_class_status',
            cancellation_reason: 'text',
            source: 'scheduled_class_source',
          },
          ch.scheduledClasses.map((s) => ({
            id: s.id,
            class_section_id: s.classSectionId,
            classroom_id: s.classroomId,
            slot_key: s.key,
            local_date: s.localDate,
            timezone: s.timezone,
            starts_at: s.startsAt,
            ends_at: s.endsAt,
            status: s.status,
            cancellation_reason: s.cancellationReason,
            source: s.source,
          })),
          [
            'classroom_id',
            'local_date',
            'timezone',
            'starts_at',
            'ends_at',
            'status',
            'cancellation_reason',
            'source',
          ],
        );
      });
    } catch (err) {
      if (pgCode(err) === PG.foreignKeyViolation) {
        throw new MissingReferenceError((err as { constraint?: string }).constraint);
      }
      if (pgCode(err) === PG.uniqueViolation) {
        throw new DuplicateDataError((err as { constraint?: string }).constraint);
      }
      throw err;
    }
  }

  async saveImportReport(r: ImportReport): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO academic_import_runs (id, institution_id, format, dry_run, status, counts, errors, warnings, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          r.importId,
          r.institutionId,
          r.format,
          r.dryRun,
          r.status,
          JSON.stringify(r.counts),
          JSON.stringify(r.errors),
          JSON.stringify(r.warnings),
          r.createdAt,
        ],
      );
    } catch (err) {
      // A rejected import may name an institution that does not exist (or no institution at all);
      // the report is still returned to the caller, it just cannot be stored.
      const code = pgCode(err);
      if (code === PG.foreignKeyViolation || code === '22P02') return;
      throw err;
    }
  }

  async getImportReport(id: string): Promise<ImportReport | null> {
    const res = await this.pool.query<{
      id: string;
      institution_id: string;
      format: 'json' | 'csv';
      dry_run: boolean;
      status: ImportReport['status'];
      counts: ImportReport['counts'];
      errors: ImportReport['errors'];
      warnings: ImportReport['warnings'];
      created_at: Date;
    }>('SELECT * FROM academic_import_runs WHERE id = $1', [id]);
    const r = res.rows[0];
    return r
      ? {
          importId: r.id,
          institutionId: r.institution_id,
          format: r.format,
          dryRun: r.dry_run,
          status: r.status,
          counts: r.counts,
          errors: r.errors,
          warnings: r.warnings,
          createdAt: iso(r.created_at),
        }
      : null;
  }

  async findScheduledClasses(q: ScheduledClassQuery): Promise<ScheduledClass[]> {
    const res = await this.pool.query<ScheduledRow>(
      `${SCHEDULED_SELECT}
        WHERE sc.slot_key IS NOT NULL
          AND ($1::uuid IS NULL OR cs.institution_id = $1)
          AND ($2::uuid IS NULL OR sc.classroom_id = $2)
          AND ($3::uuid IS NULL OR sc.class_section_id = $3)
          AND ($4::timestamptz IS NULL OR sc.ends_at > $4)
          AND ($5::timestamptz IS NULL OR sc.starts_at < $5)
          AND ($6::boolean OR sc.status <> 'cancelled')
        ORDER BY sc.starts_at, sc.id`,
      [
        q.institutionId ?? null,
        q.classroomId ?? null,
        q.classSectionId ?? null,
        q.from ?? null,
        q.to ?? null,
        q.includeCancelled === true,
      ],
    );
    return res.rows.map(toScheduled);
  }

  async getScheduledClass(id: string): Promise<ScheduledClass | null> {
    const res = await this.pool.query<ScheduledRow>(`${SCHEDULED_SELECT} WHERE sc.id = $1`, [id]);
    const row = res.rows[0];
    return row ? toScheduled(row) : null;
  }

  async getClassSection(id: string): Promise<ClassSection | null> {
    const res = await this.pool.query<SectionRow>(
      `SELECT id, institution_id, academic_term_id, external_id, course_id, professor_id, section_code, schedule, exceptions
         FROM class_sections WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row ? toSection(row) : null;
  }

  async getCourse(id: string): Promise<Course | null> {
    const res = await this.pool.query<{
      id: string;
      institution_id: string;
      academic_term_id: string;
      external_id: string | null;
      code: string;
      name: string;
      discipline: string;
      credits: number | null;
    }>(
      'SELECT id, institution_id, academic_term_id, external_id, code, name, discipline, credits FROM courses WHERE id = $1',
      [id],
    );
    const c = res.rows[0];
    return c
      ? {
          id: c.id,
          institutionId: c.institution_id,
          academicTermId: c.academic_term_id,
          externalId: c.external_id ?? '',
          code: c.code,
          name: c.name,
          discipline: c.discipline,
          credits: c.credits,
        }
      : null;
  }

  async getProfessor(id: string): Promise<Person | null> {
    const res = await this.pool.query<{
      id: string;
      institution_id: string;
      external_id: string | null;
      name: string;
      email: string;
    }>('SELECT id, institution_id, external_id, name, email FROM professors WHERE id = $1', [id]);
    const p = res.rows[0];
    return p
      ? {
          id: p.id,
          institutionId: p.institution_id,
          externalId: p.external_id ?? '',
          name: p.name,
          email: p.email,
        }
      : null;
  }

  async getTerm(id: string): Promise<Term | null> {
    const res = await this.pool.query<{
      id: string;
      institution_id: string;
      external_id: string | null;
      name: string;
      start_date: string;
      end_date: string;
      timezone: string;
    }>(
      'SELECT id, institution_id, external_id, name, start_date, end_date, timezone FROM academic_terms WHERE id = $1',
      [id],
    );
    const t = res.rows[0];
    return t
      ? {
          id: t.id,
          institutionId: t.institution_id,
          externalId: t.external_id ?? '',
          name: t.name,
          startDate: t.start_date,
          endDate: t.end_date,
          timezone: t.timezone,
        }
      : null;
  }

  async enrollmentsOfSection(classSectionId: string): Promise<Enrollment[]> {
    const res = await this.pool.query<{
      id: string;
      student_id: string;
      class_section_id: string;
      status: Enrollment['status'];
      institution_id: string;
    }>(
      `SELECT e.id, e.student_id, e.class_section_id, e.status, cs.institution_id
         FROM enrollments e JOIN class_sections cs ON cs.id = e.class_section_id WHERE e.class_section_id = $1`,
      [classSectionId],
    );
    return res.rows.map((e) => ({
      id: e.id,
      institutionId: e.institution_id,
      studentId: e.student_id,
      classSectionId: e.class_section_id,
      status: e.status,
    }));
  }
}
