export const ratio = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num / den) * 1000) / 1000 : null;

export const round = (n: number, digits = 3): number => Math.round(n * 10 ** digits) / 10 ** digits;

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function* eachDate(from: string, to: string): Generator<string> {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d;
}

export const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/** Sum of the non-null values, or null when every value is null (e.g. all suppressed). */
export function sumNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length > 0 ? sum(present) : null;
}

export function mean(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length > 0 ? round(sum(present) / present.length) : null;
}

export function weightedMean(
  pairs: readonly { value: number | null; weight: number }[],
): number | null {
  const valid = pairs.filter(
    (p): p is { value: number; weight: number } => p.value !== null && p.weight > 0,
  );
  const w = sum(valid.map((p) => p.weight));
  return w > 0 ? round(sum(valid.map((p) => p.value * p.weight)) / w) : null;
}

/** ISO-8601 week key (YYYY-Www) for a YYYY-MM-DD date. */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday decides the ISO year
  const year = d.getUTCFullYear();
  const week = 1 + Math.floor((d.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export const periodKey = (date: string, granularity: 'day' | 'week' | 'month'): string =>
  granularity === 'day' ? date : granularity === 'week' ? isoWeek(date) : date.slice(0, 7);
