import { describe, expect, it } from 'vitest';
import type { CalendarEvent, SectionRecord } from './domain.js';
import { escapeText, foldLine, formatUtc, renderIcs, zonedToUtc } from './ics.js';

const octets = (s: string): number => new TextEncoder().encode(s).length;

const baseEvent: CalendarEvent = {
  id: '0b0f5c1e-6f7a-4d1e-9a39-1f3b9f1d2c01',
  institutionId: 'inst',
  courseId: 'course',
  classSectionId: 'sec',
  extractedEventId: 'ext',
  type: 'examination',
  title: 'Prova 2; capítulos 4, 5 e 6',
  description: 'Trazer calculadora.\nSem consulta.',
  eventDate: '2026-11-20',
  eventTime: '19:00',
  timezone: 'America/Sao_Paulo',
  isOfficial: false,
  status: 'published',
  provenance: {
    recordingSessionId: 'rec',
    transcriptId: 'tr',
    segmentIndex: 42,
    startMs: 2_461_000,
    endMs: 2_468_500,
    quote: 'nossa segunda prova será no dia 20 de novembro',
    confirmedBy: 'prof',
    confirmedAt: '2026-11-04T22:00:00.000Z',
  },
  version: 3,
  createdAt: '2026-11-04T22:00:00.000Z',
  updatedAt: '2026-11-05T10:15:00.000Z',
};

const sections = new Map<string, SectionRecord>([
  [
    'sec',
    {
      classSectionId: 'sec',
      institutionId: 'inst',
      courseId: 'course',
      professorId: null,
      courseName: 'Economia Monetária',
      sectionCode: 'ECO301-A',
    },
  ],
]);

const unfold = (ics: string): string[] => ics.replace(/\r\n /g, '').split('\r\n');

describe('ics text helpers', () => {
  it('escapes TEXT values per RFC 5545 §3.3.11', () => {
    expect(escapeText('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf');
  });

  it('leaves short lines untouched and folds long ones at 75 octets', () => {
    expect(foldLine('SUMMARY:curto')).toBe('SUMMARY:curto');
    const long = `DESCRIPTION:${'x'.repeat(200)}`;
    const folded = foldLine(long);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(octets(part)).toBeLessThanOrEqual(75);
    for (const part of parts.slice(1)) expect(part.startsWith(' ')).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe(long);
  });

  it('never splits a multi-byte UTF-8 character when folding', () => {
    const long = `SUMMARY:${'ação é ótima — '.repeat(12)}`;
    const parts = foldLine(long).split('\r\n');
    for (const part of parts) {
      expect(octets(part)).toBeLessThanOrEqual(75);
      expect(part).not.toContain('�');
    }
    expect(parts.join('\r\n').replace(/\r\n /g, '')).toBe(long);
  });

  it('formats UTC timestamps and converts zoned wall-clock times', () => {
    expect(formatUtc(new Date('2026-11-04T22:30:05.000Z'))).toBe('20261104T223005Z');
    expect(zonedToUtc('2026-11-20', '19:00', 'America/Sao_Paulo').toISOString()).toBe(
      '2026-11-20T22:00:00.000Z',
    );
    // New York: EDT (-4) in July, EST (-5) in December
    expect(zonedToUtc('2026-07-01', '09:00', 'America/New_York').toISOString()).toBe(
      '2026-07-01T13:00:00.000Z',
    );
    expect(zonedToUtc('2026-12-01', '09:00', 'America/New_York').toISOString()).toBe(
      '2026-12-01T14:00:00.000Z',
    );
  });
});

describe('renderIcs', () => {
  const generatedAt = new Date('2026-11-06T12:00:00.000Z');

  it('produces a valid CRLF calendar with VTIMEZONE and a timed event', () => {
    const ics = renderIcs([baseEvent], { calendarName: 'Calendário', generatedAt, sections });
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    for (const line of ics.split('\r\n')) expect(octets(line)).toBeLessThanOrEqual(75);

    const lines = unfold(ics);
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines).toContain('VERSION:2.0');
    expect(lines).toContain('TZID:America/Sao_Paulo');
    expect(lines).toContain(`UID:${baseEvent.id}@classroom-intelligence`);
    expect(lines).toContain('DTSTAMP:20261106T120000Z');
    expect(lines).toContain('SEQUENCE:2');
    expect(lines).toContain('DTSTART;TZID=America/Sao_Paulo:20261120T190000');
    expect(lines).toContain('DTEND;TZID=America/Sao_Paulo:20261120T200000');
    expect(lines).toContain('STATUS:CONFIRMED');
    expect(lines).toContain('SUMMARY:Prova: Prova 2\\; capítulos 4\\, 5 e 6');
    const description = lines.find((l) => l.startsWith('DESCRIPTION:')) ?? '';
    expect(description).toContain('Trazer calculadora.\\nSem consulta.');
    expect(description).toContain('Disciplina: Economia Monetária (turma ECO301-A)');
    expect(description).toContain('trecho 00:41:01–00:41:08');
    expect(description).toContain('não é calendário oficial');
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(lines.at(-2)).toBe('END:VCALENDAR');
  });

  it('renders all-day and cancelled events', () => {
    const allDay: CalendarEvent = {
      ...baseEvent,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      type: 'assignment',
      eventTime: null,
      eventDate: '2026-12-31',
      status: 'cancelled',
      provenance: null,
      isOfficial: true,
      version: 1,
    };
    const lines = unfold(renderIcs([allDay], { calendarName: 'C', generatedAt, sections }));
    expect(lines).toContain('DTSTART;VALUE=DATE:20261231');
    expect(lines).toContain('DTEND;VALUE=DATE:20270101');
    expect(lines).toContain('STATUS:CANCELLED');
    expect(lines).toContain('SEQUENCE:0');
    expect(lines.find((l) => l.startsWith('SUMMARY:'))).toContain('[CANCELADO]');
    expect(lines.find((l) => l.startsWith('DESCRIPTION:'))).toContain('calendário institucional');
  });

  it('emits events outside America/Sao_Paulo as UTC instants', () => {
    const ny: CalendarEvent = {
      ...baseEvent,
      timezone: 'America/New_York',
      eventDate: '2026-07-01',
      eventTime: '09:00',
    };
    const lines = unfold(renderIcs([ny], { calendarName: 'C', generatedAt, sections }));
    expect(lines).toContain('DTSTART:20260701T130000Z');
    expect(lines).toContain('DTEND:20260701T140000Z');
  });
});
