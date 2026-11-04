import type { ClassSection, ScheduleException } from './domain.js';
import { eachDate } from './tz.js';

export interface PlannedSession {
  key: string;
  localDate: string;
  startTime: string;
  endTime: string;
  classroomId: string;
  status: 'scheduled' | 'cancelled';
  cancellationReason: string | null;
  source: 'timetable' | 'exception';
}

/**
 * Expands a section's weekly timetable over the term into concrete sessions (campus local time).
 * - `cancelled` exception: every session of that date is kept but marked cancelled.
 * - `rescheduled` exception: the date's regular sessions are replaced by one session.
 * - `extra` exception: adds a session on that date.
 */
export function expandSection(
  section: Pick<ClassSection, 'schedule' | 'exceptions'>,
  termStart: string,
  termEnd: string,
): PlannedSession[] {
  const byDate = new Map<string, ScheduleException[]>();
  for (const e of section.exceptions) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);

  const sessions: PlannedSession[] = [];
  for (const { date, dayOfWeek } of eachDate(termStart, termEnd)) {
    const exceptions = byDate.get(date) ?? [];
    const cancelled = exceptions.find((e) => e.type === 'cancelled');
    const rescheduled = exceptions.find((e) => e.type === 'rescheduled');
    const regular = section.schedule
      .map((slot, index) => ({ slot, index }))
      .filter(({ slot }) => slot.dayOfWeek === dayOfWeek);

    if (rescheduled && rescheduled.type === 'rescheduled') {
      const fallbackRoom = regular[0]?.slot.classroomId ?? section.schedule[0]?.classroomId;
      const classroomId = rescheduled.classroomId ?? fallbackRoom;
      if (classroomId) {
        sessions.push({
          key: `${date}|rescheduled`,
          localDate: date,
          startTime: rescheduled.startTime,
          endTime: rescheduled.endTime,
          classroomId,
          status: cancelled ? 'cancelled' : 'scheduled',
          cancellationReason: cancelled
            ? cancelled.type === 'cancelled'
              ? (cancelled.reason ?? 'cancelled')
              : null
            : null,
          source: 'exception',
        });
      }
    } else {
      for (const { slot, index } of regular) {
        sessions.push({
          key: `${date}|s${index}`,
          localDate: date,
          startTime: slot.startTime,
          endTime: slot.endTime,
          classroomId: slot.classroomId,
          status: cancelled ? 'cancelled' : 'scheduled',
          cancellationReason:
            cancelled && cancelled.type === 'cancelled' ? (cancelled.reason ?? 'cancelled') : null,
          source: cancelled ? 'exception' : 'timetable',
        });
      }
    }
    exceptions.forEach((e, i) => {
      if (e.type !== 'extra') return;
      sessions.push({
        key: `${date}|extra${i}`,
        localDate: date,
        startTime: e.startTime,
        endTime: e.endTime,
        classroomId: e.classroomId,
        status: 'scheduled',
        cancellationReason: null,
        source: 'exception',
      });
    });
  }
  return sessions;
}
