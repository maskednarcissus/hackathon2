const DAY_MS = 86_400_000;

const toUtc = (date: string): number => Date.parse(`${date}T00:00:00Z`);

export function addDays(date: string, days: number): string {
  return new Date(toUtc(date) + days * DAY_MS).toISOString().slice(0, 10);
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const ms = toUtc(date);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === date;
}
