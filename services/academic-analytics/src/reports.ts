import type { Directory } from './directory.js';
import type { ClassFact } from './facts.js';
import { percentile, ratio, round } from './stats.js';

export const REPORT_KINDS = [
  'capture-coverage',
  'transcription-success',
  'corrections',
  'processing-latency',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export type Cell = string | number | boolean | null;

export interface Report {
  kind: ReportKind;
  columns: string[];
  rows: Record<string, Cell>[];
  summary: Record<string, unknown>;
}

const relevant = (f: ClassFact): boolean => f.due && !f.cancelled;

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) m.set(key(i), [...(m.get(key(i)) ?? []), i]);
  return m;
}

async function captureCoverage(facts: readonly ClassFact[], directory: Directory): Promise<Report> {
  const due = facts.filter(relevant);
  const rows: Record<string, Cell>[] = [];
  for (const [key, group] of groupBy(
    due,
    (f) => `${f.localDate}|${f.campusId ?? ''}|${f.classroomId}`,
  )) {
    const [date, , classroomId] = key.split('|');
    const classroom = await directory.classroom(classroomId ?? '');
    const captured = group.filter((f) => f.captured).length;
    rows.push({
      date: date ?? '',
      campusId: classroom?.campusId ?? null,
      campusName: classroom?.campusName ?? null,
      classroomId: classroomId ?? '',
      classroomName: classroom?.name ?? null,
      scheduled: group.length,
      captured,
      missed: group.length - captured,
      coverage: ratio(captured, group.length),
    });
  }
  rows.sort(
    (a, b) =>
      String(a['date']).localeCompare(String(b['date'])) ||
      String(a['campusName'] ?? '').localeCompare(String(b['campusName'] ?? '')) ||
      String(a['classroomName'] ?? a['classroomId']).localeCompare(
        String(b['classroomName'] ?? b['classroomId']),
      ),
  );
  const captured = due.filter((f) => f.captured).length;
  const byCampus = Object.fromEntries(
    [...groupBy(due, (f) => f.campusId ?? 'unknown')].map(([campus, g]) => [
      campus,
      {
        scheduled: g.length,
        captured: g.filter((f) => f.captured).length,
        coverage: ratio(g.filter((f) => f.captured).length, g.length),
      },
    ]),
  );
  return {
    kind: 'capture-coverage',
    columns: [
      'date',
      'campusId',
      'campusName',
      'classroomId',
      'classroomName',
      'scheduled',
      'captured',
      'missed',
      'coverage',
    ],
    rows,
    summary: {
      scheduled: due.length,
      captured,
      coverage: ratio(captured, due.length),
      cancelled: facts.filter((f) => f.cancelled).length,
      byCampus,
    },
  };
}

function transcriptionSuccess(
  facts: readonly ClassFact[],
  courseNames: Map<string, string | null>,
): Report {
  const captured = facts.filter((f) => relevant(f) && f.captured);
  const rows: Record<string, Cell>[] = [];
  const reasons = new Map<string, number>();
  for (const [courseId, group] of groupBy(captured, (f) => f.courseId)) {
    const transcribed = group.filter((f) => f.transcribed);
    const failed = group.filter((f) => f.transcriptionFailed);
    const conf = transcribed.map((f) => f.meanConfidence).filter((c): c is number => c !== null);
    for (const f of failed)
      for (const r of f.failureReasons) reasons.set(r, (reasons.get(r) ?? 0) + 1);
    rows.push({
      courseId,
      courseName: courseNames.get(courseId) ?? null,
      captured: group.length,
      transcribed: transcribed.length,
      failed: failed.length,
      pending: group.length - transcribed.length - failed.length,
      successRate: ratio(transcribed.length, group.length),
      meanConfidence: conf.length > 0 ? round(conf.reduce((a, b) => a + b, 0) / conf.length) : null,
    });
  }
  rows.sort((a, b) =>
    String(a['courseName'] ?? a['courseId']).localeCompare(
      String(b['courseName'] ?? b['courseId']),
      'pt-BR',
    ),
  );
  const transcribed = captured.filter((f) => f.transcribed).length;
  const allConf = captured.map((f) => f.meanConfidence).filter((c): c is number => c !== null);
  return {
    kind: 'transcription-success',
    columns: [
      'courseId',
      'courseName',
      'captured',
      'transcribed',
      'failed',
      'pending',
      'successRate',
      'meanConfidence',
    ],
    rows,
    summary: {
      captured: captured.length,
      transcribed,
      failed: captured.filter((f) => f.transcriptionFailed).length,
      successRate: ratio(transcribed, captured.length),
      meanConfidence:
        allConf.length > 0 ? round(allConf.reduce((a, b) => a + b, 0) / allConf.length) : null,
      failuresByReason: Object.fromEntries([...reasons.entries()].sort((a, b) => b[1] - a[1])),
    },
  };
}

function corrections(facts: readonly ClassFact[], courseNames: Map<string, string | null>): Report {
  const due = facts.filter(relevant);
  const rows = [...groupBy(due, (f) => f.courseId)].map(([courseId, g]) => {
    const sum = (
      k:
        | 'correctedSegments'
        | 'eventEdits'
        | 'eventRejections'
        | 'eventsExtracted'
        | 'eventsReviewed',
    ): number => g.reduce((a, f) => a + f[k], 0);
    return {
      courseId,
      courseName: courseNames.get(courseId) ?? null,
      classesTranscribed: g.filter((f) => f.transcribed).length,
      transcriptSegmentsCorrected: sum('correctedSegments'),
      eventsExtracted: sum('eventsExtracted'),
      eventsReviewed: sum('eventsReviewed'),
      eventEdits: sum('eventEdits'),
      eventRejections: sum('eventRejections'),
      rejectionRate: ratio(sum('eventRejections'), sum('eventsExtracted')),
    } satisfies Record<string, Cell>;
  });
  rows.sort((a, b) =>
    String(a.courseName ?? a.courseId).localeCompare(String(b.courseName ?? b.courseId), 'pt-BR'),
  );
  const total = (k: keyof (typeof rows)[number]): number =>
    rows.reduce((a, r) => a + (typeof r[k] === 'number' ? r[k] : 0), 0);
  return {
    kind: 'corrections',
    columns: [
      'courseId',
      'courseName',
      'classesTranscribed',
      'transcriptSegmentsCorrected',
      'eventsExtracted',
      'eventsReviewed',
      'eventEdits',
      'eventRejections',
      'rejectionRate',
    ],
    rows,
    summary: {
      transcriptSegmentsCorrected: total('transcriptSegmentsCorrected'),
      eventEdits: total('eventEdits'),
      eventRejections: total('eventRejections'),
      eventsExtracted: total('eventsExtracted'),
    },
  };
}

function processingLatency(facts: readonly ClassFact[]): Report {
  const minutes = (a: string | null, b: string | null): number | null =>
    a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60_000)) : null;
  const stages: [string, (f: ClassFact) => number | null][] = [
    ['class_end_to_transcript', (f) => minutes(f.endsAt, f.transcriptCreatedAt)],
    ['transcript_to_summary', (f) => minutes(f.transcriptCreatedAt, f.summaryCreatedAt)],
    ['transcript_to_events', (f) => minutes(f.transcriptCreatedAt, f.firstEventCreatedAt)],
    ['class_end_to_summary', (f) => minutes(f.endsAt, f.summaryCreatedAt)],
  ];
  const due = facts.filter(relevant);
  const rows = stages.map(([stage, fn]) => {
    const values = due.map(fn).filter((v): v is number => v !== null);
    return {
      stage,
      samples: values.length,
      p50Minutes: percentile(values, 50),
      p95Minutes: percentile(values, 95),
      maxMinutes: values.length > 0 ? Math.max(...values) : null,
    };
  });
  return {
    kind: 'processing-latency',
    columns: ['stage', 'samples', 'p50Minutes', 'p95Minutes', 'maxMinutes'],
    rows,
    summary: { classes: due.length },
  };
}

export async function buildReport(
  kind: ReportKind,
  facts: readonly ClassFact[],
  directory: Directory,
  institutionId: string,
): Promise<Report> {
  const courseNames = new Map(
    (await directory.sections(institutionId)).map((s) => [s.courseId, s.courseName]),
  );
  switch (kind) {
    case 'capture-coverage':
      return captureCoverage(facts, directory);
    case 'transcription-success':
      return transcriptionSuccess(facts, courseNames);
    case 'corrections':
      return corrections(facts, courseNames);
    case 'processing-latency':
      return processingLatency(facts);
  }
}

/** RFC 4180: CRLF line endings, fields with comma, quote, CR or LF quoted, quotes doubled. */
export function toCsv(columns: readonly string[], rows: readonly Record<string, Cell>[]): string {
  const field = (v: Cell | undefined): string => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    // Neutralise spreadsheet formula injection (CSV opened in Excel / Sheets).
    if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (
    [
      columns.map((c) => field(c)).join(','),
      ...rows.map((r) => columns.map((c) => field(r[c])).join(',')),
    ].join('\r\n') + '\r\n'
  );
}
