import { z } from 'zod';
import { isValidTimeZone, localParts, addDays, toMinutes, zonedToUtc } from './tz.js';
import {
  CATEGORIES,
  CRITICAL_CATEGORIES,
  type Category,
  type ChannelToggles,
  type NotificationPreferences,
  type QuietHours,
} from './types.js';

export const DEFAULT_REMINDER_OFFSETS_HOURS = [24, 2];

const DEFAULT_TOGGLES: Record<Category, ChannelToggles> = {
  new_assessment: { in_app: true, email: true, push: true },
  deadline_change: { in_app: true, email: true, push: true },
  class_cancellation: { in_app: true, email: true, push: true },
  lecture_summary: { in_app: true, email: false, push: false },
  reminder: { in_app: true, email: false, push: true },
};

export function defaultPreferences(userId: string): NotificationPreferences {
  return {
    userId,
    categories: structuredClone(DEFAULT_TOGGLES),
    quietHours: null,
    reminderOffsetsHours: [...DEFAULT_REMINDER_OFFSETS_HOURS],
    updatedAt: null,
  };
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');
const toggles = z
  .object({ in_app: z.boolean(), email: z.boolean(), push: z.boolean() })
  .partial()
  .strict();

/** PUT body: every field optional; categories are merged channel by channel. */
export const PreferencesUpdateSchema = z
  .object({
    categories: z
      .object(Object.fromEntries(CATEGORIES.map((c) => [c, toggles.optional()])))
      .strict()
      .optional(),
    quietHours: z
      .object({
        start: hhmm,
        end: hhmm,
        timezone: z.string().refine(isValidTimeZone, 'unknown IANA time zone'),
      })
      .refine((q) => q.start !== q.end, 'start and end must differ')
      .nullable()
      .optional(),
    reminderOffsetsHours: z
      .array(z.number().int().min(1).max(168))
      .max(5)
      .refine((a) => new Set(a).size === a.length, 'offsets must be unique')
      .optional(),
  })
  .strict();
export type PreferencesUpdate = z.infer<typeof PreferencesUpdateSchema>;

export class PreferencesError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function applyUpdate(
  current: NotificationPreferences,
  update: PreferencesUpdate,
  now: Date,
): NotificationPreferences {
  const next = structuredClone(current);
  if (update.categories) {
    for (const category of CATEGORIES) {
      const patch = (update.categories as Partial<Record<Category, Partial<ChannelToggles>>>)[
        category
      ];
      if (!patch) continue;
      if (patch.in_app === false && CRITICAL_CATEGORIES.includes(category)) {
        throw new PreferencesError(
          'critical_in_app_locked',
          `in_app notifications cannot be disabled for "${category}"`,
          { category },
        );
      }
      next.categories[category] = { ...next.categories[category], ...patch };
    }
  }
  if (update.quietHours !== undefined) next.quietHours = update.quietHours;
  if (update.reminderOffsetsHours !== undefined) {
    next.reminderOffsetsHours = [...update.reminderOffsetsHours].sort((a, b) => b - a);
  }
  next.updatedAt = now.toISOString();
  return next;
}

/**
 * If `now` falls inside the quiet window, returns the instant the window ends;
 * otherwise `null`. Windows may cross midnight (22:00 → 07:00).
 */
export function quietUntil(quiet: QuietHours | null, now: Date): Date | null {
  if (!quiet) return null;
  const local = localParts(now, quiet.timezone);
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  const m = local.minutes;
  const crossesMidnight = start > end;
  const inside = crossesMidnight ? m >= start || m < end : m >= start && m < end;
  if (!inside) return null;
  const endDate = crossesMidnight && m >= start ? addDays(local.date, 1) : local.date;
  return zonedToUtc(endDate, quiet.end, quiet.timezone);
}
