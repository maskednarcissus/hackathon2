/** Time-zone helpers without external deps (Intl-based). */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  minutes: number; // minutes since local midnight
}

export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const hour = parts.hour ?? '00';
  const minute = parts.minute ?? '00';
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${minute}`,
    minutes: Number(hour) * 60 + Number(minute),
  };
}

function offsetMs(instant: Date, timeZone: string): number {
  const p = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return asUtc - (instant.getTime() - instant.getMilliseconds());
}

/** Local wall-clock date + time in `timeZone` → UTC instant (DST-safe, two-pass). */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let result = guess - offsetMs(new Date(guess), timeZone);
  result = guess - offsetMs(new Date(result), timeZone);
  return new Date(result);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};
