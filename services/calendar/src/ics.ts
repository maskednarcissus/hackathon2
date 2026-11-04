/**
 * RFC 5545 iCalendar serialisation for student calendar feeds (Phase 3 — 3.10).
 * CRLF line endings, 75-octet line folding (never splitting a UTF-8 sequence), TEXT escaping,
 * stable UIDs and SEQUENCE so subscribed clients (Google, Apple, Outlook) update in place.
 */
import type { AcademicEventType, CalendarEvent, SectionRecord } from './domain.js';

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';
export const UID_DOMAIN = 'classroom-intelligence';
/** Timed events have no end in the source data; clients get a 1-hour block. */
export const DEFAULT_TIMED_DURATION_MINUTES = 60;

const TYPE_LABELS: Record<AcademicEventType, string> = {
  examination: 'Prova',
  quiz: 'Quiz',
  assignment: 'Trabalho',
  project: 'Projeto',
  presentation: 'Apresentação',
  reading_deadline: 'Leitura',
  class_cancellation: 'Aula cancelada',
  class_reschedule: 'Aula remarcada',
  room_change: 'Mudança de sala',
  other: 'Evento acadêmico',
};

/** RFC 5545 §3.3.11 TEXT escaping. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** RFC 5545 §3.1 folding: lines ≤ 75 octets, continuation lines start with a single space. */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (currentBytes + size > limit) {
      parts.push(current);
      current = '';
      currentBytes = 0;
      limit = 74; // continuation lines carry a leading space
    }
    current += ch;
    currentBytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** Date → 20261104T223000Z */
export function formatUtc(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

const compactDate = (isoDate: string): string => isoDate.replace(/-/g, '');

function nextDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Offset in minutes (local − UTC) of `timeZone` at instant `utcMs`. */
function offsetMinutes(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - utcMs) / 60_000);
}

/** Wall-clock date/time in `timeZone` → UTC instant (handles DST by re-checking the offset). */
export function zonedToUtc(isoDate: string, time: string, timeZone: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wall = Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
  let utc = wall - offsetMinutes(timeZone, wall) * 60_000;
  utc = wall - offsetMinutes(timeZone, utc) * 60_000;
  return new Date(utc);
}

const formatTimestamp = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
};

const formatBrDate = (iso: string): string => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

/** Static VTIMEZONE for America/Sao_Paulo (no DST since 2019; -03:00 year-round). */
const SAO_PAULO_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:America/Sao_Paulo',
  'X-LIC-LOCATION:America/Sao_Paulo',
  'BEGIN:STANDARD',
  'DTSTART:19700101T000000',
  'TZOFFSETFROM:-0300',
  'TZOFFSETTO:-0300',
  'TZNAME:-03',
  'END:STANDARD',
  'END:VTIMEZONE',
];

export interface IcsOptions {
  calendarName: string;
  generatedAt: Date;
  sections: ReadonlyMap<string, SectionRecord>;
}

function describe(event: CalendarEvent, section: SectionRecord | undefined): string {
  const lines: string[] = [];
  if (event.description) lines.push(event.description, '');
  const course = section?.courseName ?? 'Disciplina';
  lines.push(
    `Disciplina: ${course}${section?.sectionCode ? ` (turma ${section.sectionCode})` : ''}`,
  );
  const p = event.provenance;
  if (p) {
    lines.push(
      `Fonte: anúncio em aula gravada, trecho ${formatTimestamp(p.startMs)}–${formatTimestamp(p.endMs)}`,
      `Trecho: "${p.quote}"`,
      `Confirmado pelo professor em ${formatBrDate(p.confirmedAt)}.`,
    );
  } else {
    lines.push('Fonte: calendário institucional.');
  }
  lines.push(
    event.isOfficial
      ? 'Evento oficial da instituição.'
      : 'Anúncio de aula (não é calendário oficial).',
  );
  if (event.status === 'cancelled') lines.push('ESTE EVENTO FOI CANCELADO.');
  return lines.join('\n');
}

function eventLines(event: CalendarEvent, opts: IcsOptions): string[] {
  const section = opts.sections.get(event.classSectionId);
  const label = TYPE_LABELS[event.type];
  const lines = [
    'BEGIN:VEVENT',
    `UID:${event.id}@${UID_DOMAIN}`,
    `DTSTAMP:${formatUtc(opts.generatedAt)}`,
    `CREATED:${formatUtc(new Date(event.createdAt))}`,
    `LAST-MODIFIED:${formatUtc(new Date(event.updatedAt))}`,
    `SEQUENCE:${Math.max(0, event.version - 1)}`,
  ];
  if (event.eventTime === null) {
    lines.push(
      `DTSTART;VALUE=DATE:${compactDate(event.eventDate)}`,
      `DTEND;VALUE=DATE:${compactDate(nextDay(event.eventDate))}`,
      'TRANSP:TRANSPARENT',
    );
  } else {
    const start = zonedToUtc(event.eventDate, event.eventTime, event.timezone);
    const end = new Date(start.getTime() + DEFAULT_TIMED_DURATION_MINUTES * 60_000);
    if (event.timezone === DEFAULT_TIMEZONE) {
      // fixed -03:00: wall clock = UTC − 3 h
      const local = (d: Date): string =>
        formatUtc(new Date(d.getTime() - 3 * 3_600_000)).slice(0, -1);
      lines.push(
        `DTSTART;TZID=${DEFAULT_TIMEZONE}:${local(start)}`,
        `DTEND;TZID=${DEFAULT_TIMEZONE}:${local(end)}`,
      );
    } else {
      // Other zones are emitted as UTC instants so no per-zone VTIMEZONE (DST rules) is needed.
      lines.push(`DTSTART:${formatUtc(start)}`, `DTEND:${formatUtc(end)}`);
    }
    lines.push('TRANSP:OPAQUE');
  }
  const summary = `${event.status === 'cancelled' ? '[CANCELADO] ' : ''}${label}: ${event.title}`;
  lines.push(
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(describe(event, section))}`,
    `CATEGORIES:${escapeText(label)}`,
    `STATUS:${event.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
    'CLASS:PRIVATE',
    'END:VEVENT',
  );
  return lines;
}

export function renderIcs(events: readonly CalendarEvent[], opts: IcsOptions): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Classroom Intelligence//Student Calendar 1.0//PT-BR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(opts.calendarName)}`,
    `X-WR-TIMEZONE:${DEFAULT_TIMEZONE}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...SAO_PAULO_VTIMEZONE,
  ];
  for (const e of events) lines.push(...eventLines(e, opts));
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
