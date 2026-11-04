import { z } from 'zod';
import type { ImportIssue } from './domain.js';
import { DATE, TIME, type ImportPayloadInput } from './schemas.js';

/** RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF/LF). Auto-detects `;` or `,` delimiter. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const DAY_NAMES: Record<string, number> = {
  dom: 0,
  domingo: 0,
  sun: 0,
  sunday: 0,
  seg: 1,
  segunda: 1,
  'segunda-feira': 1,
  mon: 1,
  monday: 1,
  ter: 2,
  terca: 2,
  'terca-feira': 2,
  tue: 2,
  tuesday: 2,
  qua: 3,
  quarta: 3,
  'quarta-feira': 3,
  wed: 3,
  wednesday: 3,
  qui: 4,
  quinta: 4,
  'quinta-feira': 4,
  thu: 4,
  thursday: 4,
  sex: 5,
  sexta: 5,
  'sexta-feira': 5,
  fri: 5,
  friday: 5,
  sab: 6,
  sabado: 6,
  sat: 6,
  saturday: 6,
};

export function parseDayOfWeek(value: string): number | null {
  const v = value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/^[0-6]$/.test(v)) return Number(v);
  return DAY_NAMES[v] ?? null;
}

export const TIMETABLE_COLUMNS = [
  'term_external_id',
  'term_name',
  'term_start',
  'term_end',
  'course_external_id',
  'course_code',
  'course_name',
  'discipline',
  'professor_external_id',
  'professor_name',
  'professor_email',
  'section_external_id',
  'section_code',
  'day_of_week',
  'start_time',
  'end_time',
  'classroom_id',
] as const;

const RowSchema = z.object({
  term_external_id: z.string().min(1),
  term_name: z.string().min(1),
  term_start: z.string().regex(DATE, 'must be YYYY-MM-DD'),
  term_end: z.string().regex(DATE, 'must be YYYY-MM-DD'),
  course_external_id: z.string().min(1),
  course_code: z.string().min(1),
  course_name: z.string().min(1),
  discipline: z.string().min(1),
  professor_external_id: z.string().min(1),
  professor_name: z.string().min(1),
  professor_email: z.string().email(),
  section_external_id: z.string().min(1),
  section_code: z.string().min(1),
  day_of_week: z.string().min(1),
  start_time: z.string().regex(TIME, 'must be HH:mm'),
  end_time: z.string().regex(TIME, 'must be HH:mm'),
  classroom_id: z.string().uuid(),
});

export interface CsvConversion {
  payload: ImportPayloadInput | null;
  errors: ImportIssue[];
}

/**
 * Converts a timetable CSV (one row per weekly slot, header row required) into an import payload.
 * Errors reference `row <n>.<column>` where n is the 1-based line number in the file.
 */
export function timetableCsvToPayload(
  text: string,
  institutionId: string,
  timezone: string | undefined,
): CsvConversion {
  const rows = parseCsv(text);
  const errors: ImportIssue[] = [];
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const missing = TIMETABLE_COLUMNS.filter((c) => !header.includes(c));
  if (rows.length === 0 || missing.length > 0) {
    return {
      payload: null,
      errors: [
        {
          path: 'row 1',
          code: 'missing_columns',
          message: `missing columns: ${missing.join(', ') || TIMETABLE_COLUMNS.join(', ')}`,
        },
      ],
    };
  }
  if (rows.length === 1)
    return { payload: null, errors: [{ path: 'row 2', code: 'empty', message: 'no data rows' }] };

  type Row = z.infer<typeof RowSchema>;
  const parsed: { line: number; row: Row; day: number }[] = [];
  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const record = Object.fromEntries(header.map((h, j) => [h, (cells[j] ?? '').trim()]));
    const res = RowSchema.safeParse(record);
    if (!res.success) {
      for (const issue of res.error.issues) {
        errors.push({
          path: `row ${line}.${String(issue.path[0] ?? '')}`,
          code: 'invalid_value',
          message: issue.message,
        });
      }
      return;
    }
    const day = parseDayOfWeek(res.data.day_of_week);
    if (day === null) {
      errors.push({
        path: `row ${line}.day_of_week`,
        code: 'invalid_value',
        message: `unknown day "${res.data.day_of_week}"`,
      });
      return;
    }
    parsed.push({ line, row: res.data, day });
  });

  const first = parsed[0]?.row;
  for (const { line, row } of parsed) {
    if (
      first &&
      (row.term_external_id !== first.term_external_id ||
        row.term_start !== first.term_start ||
        row.term_end !== first.term_end)
    ) {
      errors.push({
        path: `row ${line}.term_external_id`,
        code: 'multiple_terms',
        message: 'all rows of a timetable file must belong to the same term',
      });
    }
  }
  if (errors.length > 0 || !first) return { payload: null, errors };

  const courses = new Map<string, NonNullable<ImportPayloadInput['courses']>[number]>();
  const professors = new Map<string, NonNullable<ImportPayloadInput['professors']>[number]>();
  const sections = new Map<string, NonNullable<ImportPayloadInput['classSections']>[number]>();
  for (const { row, day } of parsed) {
    courses.set(row.course_external_id, {
      externalId: row.course_external_id,
      code: row.course_code,
      name: row.course_name,
      discipline: row.discipline,
    });
    professors.set(row.professor_external_id, {
      externalId: row.professor_external_id,
      name: row.professor_name,
      email: row.professor_email,
    });
    const section = sections.get(row.section_external_id) ?? {
      externalId: row.section_external_id,
      courseExternalId: row.course_external_id,
      professorExternalId: row.professor_external_id,
      sectionCode: row.section_code,
      schedule: [],
    };
    section.schedule.push({
      dayOfWeek: day,
      startTime: row.start_time,
      endTime: row.end_time,
      classroomId: row.classroom_id,
    });
    sections.set(row.section_external_id, section);
  }
  return {
    payload: {
      institutionId,
      ...(timezone !== undefined ? { timezone } : {}),
      term: {
        externalId: first.term_external_id,
        name: first.term_name,
        startDate: first.term_start,
        endDate: first.term_end,
      },
      courses: [...courses.values()],
      professors: [...professors.values()],
      classSections: [...sections.values()],
    },
    errors,
  };
}
