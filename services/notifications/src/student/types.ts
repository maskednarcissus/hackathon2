/** Student notifications domain — Phase 3 contract §6 (docs/architecture/phase-3-student-experience.md). */

export const CATEGORIES = [
  'new_assessment',
  'deadline_change',
  'class_cancellation',
  'lecture_summary',
  'reminder',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** `in_app` can never be disabled for these (contract §6). */
export const CRITICAL_CATEGORIES: readonly Category[] = ['deadline_change', 'class_cancellation'];

export const CHANNELS = ['in_app', 'email', 'push'] as const;
export type Channel = (typeof CHANNELS)[number];
export type DeferrableChannel = Exclude<Channel, 'in_app'>;

export type ChannelToggles = Record<Channel, boolean>;

export interface QuietHours {
  start: string; // HH:mm local
  end: string; // HH:mm local
  timezone: string; // IANA
}

export interface NotificationPreferences {
  userId: string;
  categories: Record<Category, ChannelToggles>;
  quietHours: QuietHours | null;
  reminderOffsetsHours: number[];
  updatedAt: string | null;
}

export interface UserNotification {
  id: string;
  userId: string;
  institutionId: string | null;
  category: Category;
  title: string;
  body: string;
  resourceType: 'calendar_event' | 'lecture_summary';
  resourceId: string;
  version: string;
  /** `(userId, category, resourceId, version)` */
  dedupeKey: string;
  /** Deep-link data for the student web (eventId, scheduledClassId, …). */
  data: Record<string, unknown>;
  /** Visible in the in-app inbox (false when the user disabled in_app for the category). */
  inApp: boolean;
  createdAt: string;
  readAt: string | null;
}

export interface Recipient {
  userId: string;
  studentId: string;
  institutionId: string;
  email: string | null;
}

export interface EnrollmentRecord extends Recipient {
  classSectionId: string;
  status: 'active' | 'withdrawn' | 'completed';
  syncedAt: string;
}

export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
  failureCount: number;
}

export interface DeferredDelivery {
  id: string;
  notificationId: string;
  userId: string;
  channel: DeferrableChannel;
  dueAt: string;
  createdAt: string;
}

export interface StudentDelivery {
  notificationId: string;
  userId: string;
  channel: Channel;
  status: 'sent' | 'failed' | 'deferred' | 'skipped';
  detail: string | null;
  attemptedAt: string;
}

/** Calendar event as tracked locally for change detection and reminders. */
export interface TrackedEvent {
  calendarEventId: string;
  extractedEventId: string | null;
  institutionId: string | null;
  classSectionId: string;
  courseId: string | null;
  type: string;
  title: string;
  eventDate: string; // YYYY-MM-DD
  eventTime: string | null; // HH:mm
  timezone: string;
  status: 'active' | 'cancelled';
  version: number;
  updatedAt: string;
}

export const dedupeKeyOf = (
  userId: string,
  category: Category,
  resourceId: string,
  version: string,
): string => `${userId}|${category}|${resourceId}|${version}`;
