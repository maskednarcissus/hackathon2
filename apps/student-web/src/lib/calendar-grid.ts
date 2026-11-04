import { parseDateOnly, toDateOnly } from './format';

export interface GridDay {
  date: string; // YYYY-MM-DD
  inMonth: boolean;
  isToday: boolean;
}

/** Monday-first weeks (Brazilian convention) covering the whole month. */
export function monthGrid(year: number, month: number, today: string): GridDay[][] {
  const first = new Date(Date.UTC(year, month - 1, 1, 12));
  const offset = (first.getUTCDay() + 6) % 7; // 0 = Monday
  const start = new Date(first);
  start.setUTCDate(first.getUTCDate() - offset);
  const weeks: GridDay[][] = [];
  const cursor = new Date(start);
  for (let w = 0; w < 6; w += 1) {
    const week: GridDay[] = [];
    for (let d = 0; d < 7; d += 1) {
      const date = toDateOnly(cursor);
      week.push({ date, inMonth: cursor.getUTCMonth() === month - 1, isToday: date === today });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(week);
    if (cursor.getUTCMonth() !== month - 1 && w >= 3) break;
  }
  return weeks;
}

/** Monday..Sunday containing `date`. */
export function weekDays(date: string, today: string): GridDay[] {
  const ref = parseDateOnly(date);
  const offset = (ref.getUTCDay() + 6) % 7;
  ref.setUTCDate(ref.getUTCDate() - offset);
  const days: GridDay[] = [];
  for (let i = 0; i < 7; i += 1) {
    const d = toDateOnly(ref);
    days.push({ date: d, inMonth: true, isToday: d === today });
    ref.setUTCDate(ref.getUTCDate() + 1);
  }
  return days;
}

export function addDays(date: string, days: number): string {
  const d = parseDateOnly(date);
  d.setUTCDate(d.getUTCDate() + days);
  return toDateOnly(d);
}

export function addMonths(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** Today's date in the campus timezone. */
export function todayIn(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts; // en-CA formats as YYYY-MM-DD
}

export const WEEKDAY_SHORT = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'] as const;
export const WEEKDAY_LONG = [
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
  'domingo',
] as const;
