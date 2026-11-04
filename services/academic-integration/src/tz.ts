/**
 * Minimal IANA timezone helpers built on Intl (no external dependencies).
 */

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

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) of `timeZone` from UTC at the given instant: local wall clock − UTC. */
export function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(
    parts['year'] ?? 0,
    (parts['month'] ?? 1) - 1,
    parts['day'] ?? 1,
    parts['hour'] ?? 0,
    parts['minute'] ?? 0,
    parts['second'] ?? 0,
  );
  const truncated = instant.getTime() - instant.getUTCMilliseconds();
  return asUtc - truncated;
}

/**
 * Converts a wall-clock date + time in `timeZone` to a UTC instant.
 * Ambiguous times (DST fall-back) resolve to the first occurrence; times inside a
 * DST gap (spring-forward) resolve to the same wall time shifted past the gap.
 */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const wall = Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0);
  const HALF_DAY = 14 * 3_600_000;
  const before = timeZoneOffsetMs(new Date(wall - HALF_DAY), timeZone);
  const after = timeZoneOffsetMs(new Date(wall + HALF_DAY), timeZone);
  const valid = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((instant) => instant + timeZoneOffsetMs(new Date(instant), timeZone) === wall)
    .sort((a, b) => a - b);
  return new Date(valid[0] ?? wall - before);
}

/** Calendar date (YYYY-MM-DD) of an instant in `timeZone`. */
export function localDate(instant: Date, timeZone: string): string {
  const local = new Date(instant.getTime() + timeZoneOffsetMs(instant, timeZone));
  return local.toISOString().slice(0, 10);
}

/** Iterates calendar dates (inclusive). */
export function* eachDate(
  start: string,
  end: string,
): Generator<{ date: string; dayOfWeek: number }> {
  const endMs = Date.parse(`${end}T00:00:00Z`);
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= endMs; t += 86_400_000) {
    const d = new Date(t);
    yield { date: d.toISOString().slice(0, 10), dayOfWeek: d.getUTCDay() };
  }
}
