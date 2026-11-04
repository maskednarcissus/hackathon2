/**
 * PostgreSQL implementation of the calendar repositories (integration stage §1).
 * Tables: calendar_events (V001 + V003 §4), calendar_event_changes, non_teaching_days, calendar_feed_tokens
 * (V003) and calendar_section_mirror / calendar_enrollment_mirror / calendar_terms
 * (data/migrations/pending/calendar.sql). Parameterised queries only; no DDL at start-up.
 */
import pg from 'pg';
import type {
  AcademicTerm,
  CalendarEvent,
  CalendarEventChange,
  NonTeachingDay,
  Provenance,
  SectionRecord,
} from './domain.js';
import type { FeedTokenRecord, FeedTokenRepository } from './feed-tokens.js';
import { VersionConflictError, type CalendarRepository, type EventFilter } from './repository.js';

type Row = Record<string, unknown>;
type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

async function rows(db: Queryable, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query(sql, params)).rows as Row[];
}

// DATE and TIME columns are read back as text so no timezone conversion can shift them.
const EVENT_COLUMNS = `e.*, e.event_date::text AS event_date_text, to_char(e.event_time, 'HH24:MI') AS event_time_text`;

function toEvent(r: Row): CalendarEvent {
  const transcriptId = strOrNull(r['transcript_id']);
  let provenance: Provenance | null = null;
  if (transcriptId !== null) {
    const scheduledClassId = strOrNull(r['scheduled_class_id']);
    provenance = {
      recordingSessionId: String(r['recording_session_id']),
      transcriptId,
      ...(scheduledClassId !== null ? { scheduledClassId } : {}),
      segmentIndex: Number(r['segment_index']),
      startMs: Number(r['source_start_ms']),
      endMs: Number(r['source_end_ms']),
      quote: String(r['quote']),
      confirmedBy: String(r['confirmed_by']),
      confirmedAt: iso(r['confirmed_at']),
    };
  }
  return {
    id: String(r['id']),
    institutionId: String(r['institution_id']),
    courseId: String(r['course_id']),
    classSectionId: String(r['class_section_id']),
    extractedEventId: strOrNull(r['extracted_event_id']),
    type: r['event_type'] as CalendarEvent['type'],
    title: String(r['title']),
    description: strOrNull(r['description']),
    eventDate: String(r['event_date_text']),
    eventTime: strOrNull(r['event_time_text']),
    timezone: String(r['event_timezone'] ?? 'America/Sao_Paulo'),
    isOfficial: Boolean(r['is_official']),
    status: r['status'] as CalendarEvent['status'],
    provenance,
    version: Number(r['version']),
    createdAt: iso(r['created_at']),
    updatedAt: iso(r['updated_at']),
  };
}

const eventParams = (e: CalendarEvent): unknown[] => [
  e.id,
  e.institutionId,
  e.courseId,
  e.classSectionId,
  e.extractedEventId,
  e.title,
  e.description,
  e.type,
  e.eventDate,
  e.eventTime,
  e.timezone,
  e.isOfficial,
  e.status,
  e.version,
  e.provenance?.recordingSessionId ?? null,
  e.provenance?.transcriptId ?? null,
  e.provenance?.scheduledClassId ?? null,
  e.provenance?.segmentIndex ?? null,
  e.provenance?.startMs ?? null,
  e.provenance?.endMs ?? null,
  e.provenance?.quote ?? null,
  e.provenance?.confirmedBy ?? null,
  e.provenance?.confirmedAt ?? null,
  e.createdAt,
  e.updatedAt,
];

const toChange = (r: Row): CalendarEventChange => ({
  id: String(r['id']),
  calendarEventId: String(r['calendar_event_id']),
  changedAt: iso(r['changed_at']),
  changedBy: strOrNull(r['changed_by']),
  source: r['source'] as CalendarEventChange['source'],
  changeType: r['change_type'] as CalendarEventChange['changeType'],
  field: String(r['field']),
  previousValue: strOrNull(r['previous_value']),
  newValue: strOrNull(r['new_value']),
  reason: strOrNull(r['reason']),
});

const toSection = (r: Row): SectionRecord => ({
  classSectionId: String(r['class_section_id']),
  institutionId: String(r['institution_id']),
  courseId: String(r['course_id']),
  professorId: strOrNull(r['professor_id']),
  courseName: strOrNull(r['course_name']),
  sectionCode: strOrNull(r['section_code']),
});

async function insertChanges(
  db: Queryable,
  changes: readonly CalendarEventChange[],
): Promise<void> {
  for (const c of changes) {
    await db.query(
      `INSERT INTO calendar_event_changes (id, calendar_event_id, changed_at, changed_by, source, change_type,
         field, previous_value, new_value, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        c.id,
        c.calendarEventId,
        c.changedAt,
        c.changedBy !== null && UUID_RE.test(c.changedBy) ? c.changedBy : null,
        c.source,
        c.changeType,
        c.field,
        c.previousValue,
        c.newValue,
        c.reason,
      ],
    );
  }
}

const UPDATE_EVENT_SQL = `UPDATE calendar_events SET institution_id = $2, course_id = $3, class_section_id = $4,
    extracted_event_id = $5, title = $6, description = $7, event_type = $8, event_date = $9, event_time = $10,
    event_timezone = $11, is_official = $12, status = $13, version = $14, recording_session_id = $15,
    transcript_id = $16, scheduled_class_id = $17, segment_index = $18, source_start_ms = $19,
    source_end_ms = $20, quote = $21, confirmed_by = $22, confirmed_at = $23`;

export class PgCalendarRepository implements CalendarRepository {
  constructor(private readonly pool: pg.Pool) {}

  async insertEvent(e: CalendarEvent): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO calendar_events (id, institution_id, course_id, class_section_id, extracted_event_id, title,
           description, event_type, event_date, event_time, event_timezone, is_official, status, version,
           recording_session_id, transcript_id, scheduled_class_id, segment_index, source_start_ms, source_end_ms,
           quote, confirmed_by, confirmed_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
           $22, $23, $24, $25)`,
        eventParams(e),
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new VersionConflictError(e.id);
      throw err;
    }
  }

  async updateEvent(e: CalendarEvent): Promise<void> {
    await this.pool.query(`${UPDATE_EVENT_SQL} WHERE id = $1`, eventParams(e).slice(0, 23));
  }

  async updateEventWithChanges(
    e: CalendarEvent,
    changes: readonly CalendarEventChange[],
    expectedVersion: number,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Optimistic concurrency: the version check and the write are one statement.
      const result = await client.query(`${UPDATE_EVENT_SQL} WHERE id = $1 AND version = $24`, [
        ...eventParams(e).slice(0, 23),
        expectedVersion,
      ]);
      if ((result.rowCount ?? 0) !== 1) throw new VersionConflictError(e.id);
      await insertChanges(client, changes);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async getEvent(id: string): Promise<CalendarEvent | undefined> {
    if (!UUID_RE.test(id)) return undefined;
    const r = (
      await rows(this.pool, `SELECT ${EVENT_COLUMNS} FROM calendar_events e WHERE e.id = $1`, [id])
    )[0];
    return r ? toEvent(r) : undefined;
  }

  async findByExtractedEventId(extractedEventId: string): Promise<CalendarEvent | undefined> {
    const r = (
      await rows(
        this.pool,
        `SELECT ${EVENT_COLUMNS} FROM calendar_events e WHERE e.extracted_event_id = $1`,
        [extractedEventId],
      )
    )[0];
    return r ? toEvent(r) : undefined;
  }

  async listEvents(f: EventFilter): Promise<CalendarEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (f.institutionId !== undefined) add('e.institution_id = ?', f.institutionId);
    if (f.courseId !== undefined) add('e.course_id = ?', f.courseId);
    if (f.classSectionId !== undefined) add('e.class_section_id = ?', f.classSectionId);
    if (f.classSectionIds !== undefined)
      add('e.class_section_id = ANY(?::uuid[])', [...f.classSectionIds]);
    if (f.from !== undefined) add('e.event_date >= ?::date', f.from);
    if (f.to !== undefined) add('e.event_date <= ?::date', f.to);
    if (f.includeCancelled !== true) where.push(`e.status <> 'cancelled'`);
    const sql = `SELECT ${EVENT_COLUMNS} FROM calendar_events e
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.event_date, e.event_time NULLS FIRST, e.created_at`;
    return (await rows(this.pool, sql, params)).map(toEvent);
  }

  async appendChanges(changes: readonly CalendarEventChange[]): Promise<void> {
    await insertChanges(this.pool, changes);
  }

  async listChanges(calendarEventId: string): Promise<CalendarEventChange[]> {
    return (
      await rows(
        this.pool,
        'SELECT * FROM calendar_event_changes WHERE calendar_event_id = $1 ORDER BY changed_at, seq',
        [calendarEventId],
      )
    ).map(toChange);
  }

  async upsertSection(s: SectionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO calendar_section_mirror (class_section_id, institution_id, course_id, professor_id, course_name,
         section_code, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (class_section_id) DO UPDATE SET institution_id = EXCLUDED.institution_id,
         course_id = EXCLUDED.course_id, professor_id = EXCLUDED.professor_id,
         course_name = EXCLUDED.course_name, section_code = EXCLUDED.section_code, synced_at = NOW()`,
      [s.classSectionId, s.institutionId, s.courseId, s.professorId, s.courseName, s.sectionCode],
    );
  }

  async getSection(classSectionId: string): Promise<SectionRecord | undefined> {
    if (!UUID_RE.test(classSectionId)) return undefined;
    const r = (
      await rows(this.pool, 'SELECT * FROM calendar_section_mirror WHERE class_section_id = $1', [
        classSectionId,
      ])
    )[0];
    return r ? toSection(r) : undefined;
  }

  async replaceEnrollments(classSectionId: string, studentIds: readonly string[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM calendar_enrollment_mirror WHERE class_section_id = $1 AND NOT (student_id = ANY($2::uuid[]))',
        [classSectionId, [...studentIds]],
      );
      await this.insertEnrollments(client, classSectionId, studentIds);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async addEnrollments(classSectionId: string, studentIds: readonly string[]): Promise<void> {
    await this.insertEnrollments(this.pool, classSectionId, studentIds);
  }

  private async insertEnrollments(
    db: Queryable,
    classSectionId: string,
    studentIds: readonly string[],
  ): Promise<void> {
    if (studentIds.length === 0) return;
    await db.query(
      `INSERT INTO calendar_enrollment_mirror (class_section_id, student_id, synced_at)
       SELECT $1, unnest($2::uuid[]), NOW()
       ON CONFLICT (class_section_id, student_id) DO UPDATE SET synced_at = NOW()`,
      [classSectionId, [...studentIds]],
    );
  }

  async studentsOf(classSectionId: string): Promise<ReadonlySet<string>> {
    const r = await rows(
      this.pool,
      'SELECT student_id FROM calendar_enrollment_mirror WHERE class_section_id = $1',
      [classSectionId],
    );
    return new Set(r.map((x) => String(x['student_id'])));
  }

  async sectionsOfStudent(studentId: string): Promise<string[]> {
    if (!UUID_RE.test(studentId)) return [];
    const r = await rows(
      this.pool,
      'SELECT class_section_id FROM calendar_enrollment_mirror WHERE student_id = $1 ORDER BY class_section_id',
      [studentId],
    );
    return r.map((x) => String(x['class_section_id']));
  }

  async enrollmentsByInstitution(institutionId: string): Promise<Map<string, ReadonlySet<string>>> {
    const r = await rows(
      this.pool,
      `SELECT m.class_section_id, m.student_id FROM calendar_enrollment_mirror m
       JOIN calendar_section_mirror s ON s.class_section_id = m.class_section_id
       WHERE s.institution_id = $1`,
      [institutionId],
    );
    const out = new Map<string, Set<string>>();
    for (const x of r) {
      const section = String(x['class_section_id']);
      const set = out.get(section) ?? new Set<string>();
      set.add(String(x['student_id']));
      out.set(section, set);
    }
    return out;
  }

  async upsertNonTeachingDays(days: readonly NonTeachingDay[]): Promise<void> {
    for (const d of days) {
      await this.pool.query(
        `INSERT INTO non_teaching_days (institution_id, day, description) VALUES ($1, $2, $3)
         ON CONFLICT (institution_id, day) DO UPDATE SET description = EXCLUDED.description`,
        [d.institutionId, d.date, d.description],
      );
    }
  }

  async getNonTeachingDay(
    institutionId: string,
    date: string,
  ): Promise<NonTeachingDay | undefined> {
    const r = (
      await rows(
        this.pool,
        'SELECT institution_id, day::text AS day, description FROM non_teaching_days WHERE institution_id = $1 AND day = $2::date',
        [institutionId, date],
      )
    )[0];
    return r
      ? {
          institutionId: String(r['institution_id']),
          date: String(r['day']),
          description: String(r['description']),
        }
      : undefined;
  }

  async listNonTeachingDays(institutionId: string): Promise<NonTeachingDay[]> {
    return (
      await rows(
        this.pool,
        'SELECT institution_id, day::text AS day, description FROM non_teaching_days WHERE institution_id = $1 ORDER BY day',
        [institutionId],
      )
    ).map((r) => ({
      institutionId: String(r['institution_id']),
      date: String(r['day']),
      description: String(r['description']),
    }));
  }

  async upsertTerm(t: AcademicTerm): Promise<void> {
    await this.pool.query(
      `INSERT INTO calendar_terms (id, institution_id, name, start_date, end_date) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET institution_id = EXCLUDED.institution_id, name = EXCLUDED.name,
         start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date`,
      [t.id, t.institutionId, t.name, t.startDate, t.endDate],
    );
  }

  async listTerms(institutionId: string): Promise<AcademicTerm[]> {
    return (
      await rows(
        this.pool,
        `SELECT id, institution_id, name, start_date::text AS start_date, end_date::text AS end_date
         FROM calendar_terms WHERE institution_id = $1 ORDER BY start_date`,
        [institutionId],
      )
    ).map((r) => ({
      id: String(r['id']),
      institutionId: String(r['institution_id']),
      name: strOrNull(r['name']),
      startDate: String(r['start_date']),
      endDate: String(r['end_date']),
    }));
  }
}

export class PgFeedTokenRepository implements FeedTokenRepository {
  constructor(private readonly pool: pg.Pool) {}

  async put(record: FeedTokenRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO calendar_feed_tokens (student_id, token_hash, created_at, last_used_at) VALUES ($1, $2, $3, NULL)
       ON CONFLICT (student_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = EXCLUDED.created_at,
         last_used_at = NULL`,
      [record.studentId, record.tokenHash, record.createdAt],
    );
  }

  async get(studentId: string): Promise<FeedTokenRecord | undefined> {
    if (!UUID_RE.test(studentId)) return undefined;
    const r = (
      await rows(this.pool, 'SELECT * FROM calendar_feed_tokens WHERE student_id = $1', [studentId])
    )[0];
    return r
      ? {
          studentId: String(r['student_id']),
          tokenHash: String(r['token_hash']).trim(),
          createdAt: iso(r['created_at']),
        }
      : undefined;
  }

  async delete(studentId: string): Promise<boolean> {
    if (!UUID_RE.test(studentId)) return false;
    const result = await this.pool.query('DELETE FROM calendar_feed_tokens WHERE student_id = $1', [
      studentId,
    ]);
    return (result.rowCount ?? 0) > 0;
  }
}
