import type { Classroom, Directory, Section } from './directory.js';
import type { ClassFact } from './facts.js';
import { iso, isoOrNull, withTransaction, type Pool } from './platform/pg.js';
import type { AnalyticsRepository, DailySnapshot, Syllabus } from './repository.js';

/** Syllabi and daily snapshots on `syllabus_items`, `analytics_daily_snapshots`, `analytics_class_facts` (V004). */
export class PgAnalyticsRepository implements AnalyticsRepository {
  constructor(private readonly pool: Pool) {}

  putSyllabus(s: Syllabus): Promise<void> {
    return withTransaction(this.pool, async (c) => {
      await c.query('DELETE FROM syllabus_items WHERE course_id = $1', [s.courseId]);
      if (s.items.length === 0) {
        // An empty syllabus is still a registered syllabus: keep a marker row-free record via updated_at.
        await c.query(
          `INSERT INTO analytics_empty_syllabi (course_id, institution_id, updated_at, updated_by) VALUES ($1, $2, $3, $4)
           ON CONFLICT (course_id) DO UPDATE SET updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
          [s.courseId, s.institutionId, s.updatedAt, s.updatedBy],
        );
        return;
      }
      await c.query('DELETE FROM analytics_empty_syllabi WHERE course_id = $1', [s.courseId]);
      await c.query(
        `INSERT INTO syllabus_items (course_id, item_id, institution_id, title, keywords, planned_week, position, updated_by, updated_at)
         SELECT $1, u.item_id, $2, u.title, ARRAY(SELECT jsonb_array_elements_text(u.keywords)), u.planned_week, u.position, $3, $4
           FROM jsonb_to_recordset($5::jsonb) AS u(item_id text, title text, keywords jsonb, planned_week int, position int)`,
        [
          s.courseId,
          s.institutionId,
          s.updatedBy,
          s.updatedAt,
          JSON.stringify(
            s.items.map((i, position) => ({
              item_id: i.id,
              title: i.title,
              keywords: i.keywords,
              planned_week: i.plannedWeek,
              position,
            })),
          ),
        ],
      );
    });
  }

  async getSyllabus(courseId: string): Promise<Syllabus | null> {
    const res = await this.pool.query<{
      item_id: string;
      institution_id: string;
      title: string;
      keywords: string[];
      planned_week: number | null;
      updated_by: string | null;
      updated_at: Date;
    }>(
      `SELECT item_id, institution_id, title, keywords, planned_week, updated_by, updated_at
         FROM syllabus_items WHERE course_id = $1 ORDER BY position`,
      [courseId],
    );
    const first = res.rows[0];
    if (!first) {
      const empty = await this.pool.query<{
        institution_id: string;
        updated_at: Date;
        updated_by: string | null;
      }>(
        'SELECT institution_id, updated_at, updated_by FROM analytics_empty_syllabi WHERE course_id = $1',
        [courseId],
      );
      const e = empty.rows[0];
      return e
        ? {
            courseId,
            institutionId: e.institution_id,
            items: [],
            updatedAt: iso(e.updated_at),
            updatedBy: e.updated_by,
          }
        : null;
    }
    return {
      courseId,
      institutionId: first.institution_id,
      items: res.rows.map((r) => ({
        id: r.item_id,
        title: r.title,
        keywords: r.keywords,
        plannedWeek: r.planned_week,
      })),
      updatedAt: iso(first.updated_at),
      updatedBy: first.updated_by,
    };
  }

  putSnapshot(s: DailySnapshot): Promise<void> {
    return withTransaction(this.pool, async (c) => {
      // Re-running a day replaces its facts.
      await c.query(
        'DELETE FROM analytics_daily_snapshots WHERE institution_id = $1 AND snapshot_date = $2',
        [s.institutionId, s.date],
      );
      await c.query(
        'INSERT INTO analytics_daily_snapshots (institution_id, snapshot_date, generated_at) VALUES ($1, $2, $3)',
        [s.institutionId, s.date, s.generatedAt],
      );
      if (s.classes.length === 0) return;
      await c.query(
        `INSERT INTO analytics_class_facts (institution_id, snapshot_date, scheduled_class_id, class_section_id, course_id,
            professor_id, classroom_id, campus_id, local_date, starts_at, ends_at, cancelled, captured, recording_session_ids,
            transcribed, transcription_failed, failure_reasons, mean_confidence, corrected_segments, transcript_created_at,
            structured, summary_created_at, events_extracted, events_reviewed, event_edits, event_rejections,
            review_latencies_minutes, first_event_created_at, due)
         SELECT $1, $2, f.scheduled_class_id, f.class_section_id, f.course_id, f.professor_id, f.classroom_id, f.campus_id,
                f.local_date, f.starts_at, f.ends_at, f.cancelled, f.captured,
                ARRAY(SELECT jsonb_array_elements_text(f.recording_session_ids))::uuid[],
                f.transcribed, f.transcription_failed, ARRAY(SELECT jsonb_array_elements_text(f.failure_reasons)),
                f.mean_confidence, f.corrected_segments, f.transcript_created_at, f.structured, f.summary_created_at,
                f.events_extracted, f.events_reviewed, f.event_edits, f.event_rejections,
                ARRAY(SELECT jsonb_array_elements_text(f.review_latencies_minutes))::int[], f.first_event_created_at, f.due
           FROM jsonb_to_recordset($3::jsonb) AS f(
                scheduled_class_id uuid, class_section_id uuid, course_id uuid, professor_id uuid, classroom_id uuid,
                campus_id uuid, local_date date, starts_at timestamptz, ends_at timestamptz, cancelled boolean,
                captured boolean, recording_session_ids jsonb, transcribed boolean, transcription_failed boolean,
                failure_reasons jsonb, mean_confidence numeric, corrected_segments int, transcript_created_at timestamptz,
                structured boolean, summary_created_at timestamptz, events_extracted int, events_reviewed int,
                event_edits int, event_rejections int, review_latencies_minutes jsonb, first_event_created_at timestamptz,
                due boolean)`,
        [
          s.institutionId,
          s.date,
          JSON.stringify(
            s.classes.map((f) => ({
              scheduled_class_id: f.scheduledClassId,
              class_section_id: f.classSectionId,
              course_id: f.courseId,
              professor_id: f.professorId,
              classroom_id: f.classroomId,
              campus_id: f.campusId,
              local_date: f.localDate,
              starts_at: f.startsAt,
              ends_at: f.endsAt,
              cancelled: f.cancelled,
              captured: f.captured,
              recording_session_ids: f.recordingSessionIds,
              transcribed: f.transcribed,
              transcription_failed: f.transcriptionFailed,
              failure_reasons: f.failureReasons,
              mean_confidence: f.meanConfidence,
              corrected_segments: f.correctedSegments,
              transcript_created_at: f.transcriptCreatedAt,
              structured: f.structured,
              summary_created_at: f.summaryCreatedAt,
              events_extracted: f.eventsExtracted,
              events_reviewed: f.eventsReviewed,
              event_edits: f.eventEdits,
              event_rejections: f.eventRejections,
              review_latencies_minutes: f.reviewLatenciesMinutes,
              first_event_created_at: f.firstEventCreatedAt,
              due: f.due,
            })),
          ),
        ],
      );
    });
  }

  async snapshots(institutionId: string, from: string, to: string): Promise<DailySnapshot[]> {
    const days = await this.pool.query<{ snapshot_date: string; generated_at: Date }>(
      `SELECT snapshot_date, generated_at FROM analytics_daily_snapshots
        WHERE institution_id = $1 AND snapshot_date BETWEEN $2 AND $3 ORDER BY snapshot_date`,
      [institutionId, from, to],
    );
    if (days.rows.length === 0) return [];
    const facts = await this.pool.query<FactRow>(
      `SELECT * FROM analytics_class_facts WHERE institution_id = $1 AND snapshot_date BETWEEN $2 AND $3 ORDER BY starts_at`,
      [institutionId, from, to],
    );
    const byDay = new Map<string, ClassFact[]>();
    for (const r of facts.rows)
      byDay.set(r.snapshot_date, [...(byDay.get(r.snapshot_date) ?? []), toFact(r)]);
    return days.rows.map((d) => ({
      institutionId,
      date: d.snapshot_date,
      generatedAt: iso(d.generated_at),
      classes: byDay.get(d.snapshot_date) ?? [],
    }));
  }
}

interface FactRow {
  institution_id: string;
  snapshot_date: string;
  scheduled_class_id: string;
  class_section_id: string;
  course_id: string | null;
  professor_id: string | null;
  classroom_id: string | null;
  campus_id: string | null;
  local_date: string;
  starts_at: Date;
  ends_at: Date;
  cancelled: boolean;
  due: boolean | null;
  captured: boolean;
  recording_session_ids: string[];
  transcribed: boolean;
  transcription_failed: boolean;
  failure_reasons: string[];
  mean_confidence: number | null;
  corrected_segments: number;
  transcript_created_at: Date | null;
  structured: boolean;
  summary_created_at: Date | null;
  events_extracted: number;
  events_reviewed: number;
  event_edits: number;
  event_rejections: number;
  review_latencies_minutes: number[];
  first_event_created_at: Date | null;
}

const toFact = (r: FactRow): ClassFact => ({
  scheduledClassId: r.scheduled_class_id,
  institutionId: r.institution_id,
  classSectionId: r.class_section_id,
  courseId: r.course_id ?? '',
  professorId: r.professor_id ?? '',
  classroomId: r.classroom_id ?? '',
  campusId: r.campus_id,
  localDate: r.local_date,
  startsAt: iso(r.starts_at),
  endsAt: iso(r.ends_at),
  cancelled: r.cancelled,
  // Snapshots are only taken for closed days, so every class had ended.
  due: r.due ?? true,
  captured: r.captured,
  recordingSessionIds: r.recording_session_ids,
  transcribed: r.transcribed,
  transcriptionFailed: r.transcription_failed,
  failureReasons: r.failure_reasons,
  meanConfidence: r.mean_confidence,
  correctedSegments: r.corrected_segments,
  transcriptCreatedAt: isoOrNull(r.transcript_created_at),
  structured: r.structured,
  summaryCreatedAt: isoOrNull(r.summary_created_at),
  eventsExtracted: r.events_extracted,
  eventsReviewed: r.events_reviewed,
  eventEdits: r.event_edits,
  eventRejections: r.event_rejections,
  reviewLatenciesMinutes: r.review_latencies_minutes,
  firstEventCreatedAt: isoOrNull(r.first_event_created_at),
});

interface SectionRow {
  class_section_id: string;
  institution_id: string;
  course_id: string;
  course_code: string | null;
  course_name: string | null;
  program_id: string | null;
  program_name: string | null;
  professor_id: string | null;
  professor_name: string | null;
  section_code: string | null;
  term_start_date: string | null;
  term_end_date: string | null;
}

const toSection = (r: SectionRow): Section => ({
  classSectionId: r.class_section_id,
  institutionId: r.institution_id,
  courseId: r.course_id,
  courseCode: r.course_code,
  courseName: r.course_name,
  programId: r.program_id,
  programName: r.program_name,
  professorId: r.professor_id,
  professorName: r.professor_name,
  sectionCode: r.section_code,
  termStartDate: r.term_start_date,
  termEndDate: r.term_end_date,
});

/** Mirror of the academic structure on `analytics_sections` / `analytics_enrollments` / `analytics_classrooms` (pending). */
export class PgDirectory implements Directory {
  constructor(private readonly pool: Pool) {}

  async upsertSections(sections: Section[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO analytics_sections (class_section_id, institution_id, course_id, course_code, course_name, program_id,
          program_name, professor_id, professor_name, section_code, term_start_date, term_end_date, synced_at)
       SELECT s.class_section_id, s.institution_id, s.course_id, s.course_code, s.course_name, s.program_id, s.program_name,
              s.professor_id, s.professor_name, s.section_code, s.term_start_date, s.term_end_date, NOW()
         FROM jsonb_to_recordset($1::jsonb) AS s(class_section_id uuid, institution_id uuid, course_id uuid, course_code text,
              course_name text, program_id uuid, program_name text, professor_id uuid, professor_name text,
              section_code text, term_start_date date, term_end_date date)
       ON CONFLICT (class_section_id) DO UPDATE SET
         institution_id = EXCLUDED.institution_id, course_id = EXCLUDED.course_id, course_code = EXCLUDED.course_code,
         course_name = EXCLUDED.course_name, program_id = EXCLUDED.program_id, program_name = EXCLUDED.program_name,
         professor_id = EXCLUDED.professor_id, professor_name = EXCLUDED.professor_name,
         section_code = EXCLUDED.section_code, term_start_date = EXCLUDED.term_start_date,
         term_end_date = EXCLUDED.term_end_date, synced_at = NOW()`,
      [
        JSON.stringify(
          sections.map((s) => ({
            class_section_id: s.classSectionId,
            institution_id: s.institutionId,
            course_id: s.courseId,
            course_code: s.courseCode,
            course_name: s.courseName,
            program_id: s.programId,
            program_name: s.programName,
            professor_id: s.professorId,
            professor_name: s.professorName,
            section_code: s.sectionCode,
            term_start_date: s.termStartDate,
            term_end_date: s.termEndDate,
          })),
        ),
      ],
    );
  }

  setEnrollments(
    classSectionId: string,
    studentIds: string[],
    mode: 'replace' | 'append',
  ): Promise<number> {
    return withTransaction(this.pool, async (c) => {
      if (mode === 'replace')
        await c.query('DELETE FROM analytics_enrollments WHERE class_section_id = $1', [
          classSectionId,
        ]);
      await c.query(
        `INSERT INTO analytics_enrollments (class_section_id, student_id)
         SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
        [classSectionId, studentIds],
      );
      const n = await c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM analytics_enrollments WHERE class_section_id = $1',
        [classSectionId],
      );
      return n.rows[0]?.n ?? 0;
    });
  }

  async upsertClassrooms(classrooms: Classroom[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO analytics_classrooms (classroom_id, institution_id, campus_id, campus_name, name, synced_at)
       SELECT c.classroom_id, c.institution_id, c.campus_id, c.campus_name, c.name, NOW()
         FROM jsonb_to_recordset($1::jsonb) AS c(classroom_id uuid, institution_id uuid, campus_id uuid, campus_name text, name text)
       ON CONFLICT (classroom_id) DO UPDATE SET institution_id = EXCLUDED.institution_id, campus_id = EXCLUDED.campus_id,
         campus_name = EXCLUDED.campus_name, name = EXCLUDED.name, synced_at = NOW()`,
      [
        JSON.stringify(
          classrooms.map((c) => ({
            classroom_id: c.classroomId,
            institution_id: c.institutionId,
            campus_id: c.campusId,
            campus_name: c.campusName,
            name: c.name,
          })),
        ),
      ],
    );
  }

  async sections(institutionId: string): Promise<Section[]> {
    const res = await this.pool.query<SectionRow>(
      'SELECT * FROM analytics_sections WHERE institution_id = $1 ORDER BY class_section_id',
      [institutionId],
    );
    return res.rows.map(toSection);
  }

  async section(classSectionId: string): Promise<Section | null> {
    const res = await this.pool.query<SectionRow>(
      'SELECT * FROM analytics_sections WHERE class_section_id = $1',
      [classSectionId],
    );
    const row = res.rows[0];
    return row ? toSection(row) : null;
  }

  async sectionsOfCourse(courseId: string): Promise<Section[]> {
    const res = await this.pool.query<SectionRow>(
      'SELECT * FROM analytics_sections WHERE course_id = $1 ORDER BY class_section_id',
      [courseId],
    );
    return res.rows.map(toSection);
  }

  async students(classSectionId: string): Promise<ReadonlySet<string>> {
    const res = await this.pool.query<{ student_id: string }>(
      'SELECT student_id FROM analytics_enrollments WHERE class_section_id = $1',
      [classSectionId],
    );
    return new Set(res.rows.map((r) => r.student_id));
  }

  async classroom(classroomId: string): Promise<Classroom | null> {
    const res = await this.pool.query<{
      classroom_id: string;
      institution_id: string;
      campus_id: string;
      campus_name: string | null;
      name: string | null;
    }>(
      'SELECT classroom_id, institution_id, campus_id, campus_name, name FROM analytics_classrooms WHERE classroom_id = $1',
      [classroomId],
    );
    const r = res.rows[0];
    return r
      ? {
          classroomId: r.classroom_id,
          institutionId: r.institution_id,
          campusId: r.campus_id,
          campusName: r.campus_name,
          name: r.name,
        }
      : null;
  }
}
