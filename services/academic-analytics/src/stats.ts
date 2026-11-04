/** Minimum cohort size: aggregates over fewer students are suppressed (phase-4 contract). */
export const MIN_COHORT = 5;

export type Cohort<T extends Record<string, number>> =
  | ({ suppressed: false; cohortSize: number } & T)
  | ({ suppressed: true; cohortSize: null } & { [K in keyof T]: null });

/** Returns the metrics when the cohort is large enough, otherwise nulls with `suppressed: true`. */
export function cohort<T extends Record<string, number>>(size: number, metrics: T): Cohort<T> {
  if (size >= MIN_COHORT) return { suppressed: false, cohortSize: size, ...metrics };
  const nulls = Object.fromEntries(Object.keys(metrics).map((k) => [k, null])) as {
    [K in keyof T]: null;
  };
  return { suppressed: true as const, cohortSize: null, ...nulls } as Cohort<T>;
}

/** Student count respecting the cohort rule: null below the threshold. */
export const countOrSuppressed = (n: number): { count: number | null; suppressed: boolean } =>
  n >= MIN_COHORT ? { count: n, suppressed: false } : { count: null, suppressed: true };

/** Nearest-rank percentile (p in 0..100). */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

export const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};

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
