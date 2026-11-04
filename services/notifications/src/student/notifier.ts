import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '../schemas.js';
import type {
  CalendarEventDetails,
  CalendarEventSource,
  ClassDirectory,
  EnrollmentDirectory,
} from './directories.js';
import type { EmailSender } from './email.js';
import { defaultPreferences, quietUntil } from './preferences.js';
import type { StudentStore } from './store.js';
import { addDays, zonedToUtc } from './tz.js';
import {
  dedupeKeyOf,
  type Category,
  type DeferrableChannel,
  type NotificationPreferences,
  type Recipient,
  type TrackedEvent,
  type UserNotification,
} from './types.js';
import type { PushSender } from './webpush.js';

export interface NotifierLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface NotifierDeps {
  store: StudentStore;
  enrollments: EnrollmentDirectory;
  calendar: CalendarEventSource;
  classes: ClassDirectory;
  email: EmailSender;
  push: PushSender;
  clock: () => Date;
  logger: NotifierLogger;
  /** Base URL of the student web, for deep links. */
  studentWebUrl?: string;
}

export interface FanOutResult {
  category: Category | null;
  created: number;
  duplicates: number;
  recipients: number;
  skippedReason?: string;
}

/** Event types that produce assessment reminders (announcements do not). */
const REMINDER_TYPES = new Set([
  'examination',
  'quiz',
  'assignment',
  'project',
  'presentation',
  'reading_deadline',
  'other',
]);
const ANNOUNCEMENT_TYPES = new Set(['class_cancellation', 'class_reschedule', 'room_change']);

/** When an assessment has no time, it is treated as due at 08:00 local (start of the academic day). */
export const DEFAULT_EVENT_TIME = '08:00';

const TYPE_LABEL: Record<string, string> = {
  examination: 'Prova',
  quiz: 'Quiz',
  assignment: 'Trabalho',
  project: 'Projeto',
  presentation: 'Apresentação',
  reading_deadline: 'Leitura',
  class_cancellation: 'Aula cancelada',
  class_reschedule: 'Aula remarcada',
  room_change: 'Mudança de sala',
  other: 'Evento',
};

const brDate = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};
const when = (e: { eventDate: string; eventTime: string | null }): string =>
  e.eventTime ? `${brDate(e.eventDate)} às ${e.eventTime}` : brDate(e.eventDate);

/** Student-web routes (apps/student-web): `/calendario/{calendarEventId}`, `/aulas/{scheduledClassId}`. */
export function studentWebPath(id: string, kind: 'calendar_event' | 'scheduled_class'): string {
  return kind === 'calendar_event'
    ? `/calendario/${encodeURIComponent(id)}`
    : `/aulas/${encodeURIComponent(id)}`;
}

/** In-app deep link (relative path) for a stored notification. */
export function notificationLink(n: {
  resourceType: string;
  resourceId: string;
  data: Record<string, unknown>;
}): string | undefined {
  const calendarEventId =
    typeof n.data.calendarEventId === 'string'
      ? n.data.calendarEventId
      : n.resourceType === 'calendar_event'
        ? n.resourceId
        : null;
  if (calendarEventId) return studentWebPath(calendarEventId, 'calendar_event');
  if (typeof n.data.scheduledClassId === 'string') {
    return studentWebPath(n.data.scheduledClassId, 'scheduled_class');
  }
  return undefined;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

interface Draft {
  category: Category;
  title: string;
  body: string;
  resourceType: UserNotification['resourceType'];
  resourceId: string;
  version: string;
  institutionId: string | null;
  data: Record<string, unknown>;
  urgency: 'normal' | 'high';
}

/**
 * Student notifications (deliverables 3.11, 3.12): fan-out of academic events to
 * actively enrolled students, honouring per-user preferences, quiet hours and dedup.
 */
export class StudentNotifier {
  constructor(private readonly deps: NotifierDeps) {}

  // ------------------------------------------------------------------ triggers
  async handleEvent(event: EventEnvelope): Promise<FanOutResult | null> {
    switch (event.type) {
      case 'event.published':
      case 'calendar.event_published':
        return this.onPublished(event);
      case 'event.updated':
      case 'calendar.event_updated':
      case 'event.cancelled':
      case 'calendar.event_cancelled':
        return this.onUpdated(event);
      case 'lecture.structured':
        return this.onLectureStructured(event);
      default:
        return null;
    }
  }

  /** Inline details win (calendar-originated events); otherwise the calendar service is asked. */
  private async resolveEvent(event: EventEnvelope): Promise<CalendarEventDetails | undefined> {
    const d = event.data;
    if (
      str(d.classSectionId) &&
      str(d.title) &&
      str(d.eventDate) &&
      str(d.calendarEventId ?? d.id)
    ) {
      return {
        id: str(d.calendarEventId) ?? (d.id as string),
        institutionId: event.institutionId ?? str(d.institutionId),
        courseId: str(d.courseId),
        classSectionId: d.classSectionId as string,
        extractedEventId: str(d.extractedEventId) ?? str(d.eventId),
        type: str(d.type) ?? 'other',
        title: d.title as string,
        eventDate: d.eventDate as string,
        eventTime: str(d.eventTime),
        timezone: str(d.timezone) ?? 'America/Sao_Paulo',
        status: str(d.status) ?? 'published',
        version: typeof d.version === 'number' ? d.version : 1,
      };
    }
    let calendarEventId = str(d.calendarEventId);
    if (!calendarEventId && str(d.eventId)) {
      calendarEventId =
        (await this.deps.store.findTrackedByExtracted(d.eventId as string))?.calendarEventId ??
        null;
    }
    if (!calendarEventId) return undefined;
    return this.deps.calendar.get(calendarEventId);
  }

  private toTracked(e: CalendarEventDetails, extractedFallback: string | null): TrackedEvent {
    return {
      calendarEventId: e.id,
      extractedEventId: e.extractedEventId ?? extractedFallback,
      institutionId: e.institutionId,
      classSectionId: e.classSectionId,
      courseId: e.courseId,
      type: e.type,
      title: e.title,
      eventDate: e.eventDate,
      eventTime: e.eventTime,
      timezone: e.timezone,
      status: e.status === 'cancelled' ? 'cancelled' : 'active',
      version: e.version,
      updatedAt: this.deps.clock().toISOString(),
    };
  }

  private async onPublished(event: EventEnvelope): Promise<FanOutResult> {
    const details = await this.resolveEvent(event);
    if (!details)
      return {
        category: null,
        created: 0,
        duplicates: 0,
        recipients: 0,
        skippedReason: 'event_not_found',
      };
    const tracked = this.toTracked(details, str(event.data.eventId));
    await this.deps.store.saveTrackedEvent(tracked);
    if (tracked.status === 'cancelled') {
      return {
        category: null,
        created: 0,
        duplicates: 0,
        recipients: 0,
        skippedReason: 'already_cancelled',
      };
    }
    const isCancellation = tracked.type === 'class_cancellation';
    const label = TYPE_LABEL[tracked.type] ?? 'Evento';
    const draft: Draft = isCancellation
      ? {
          category: 'class_cancellation',
          title: 'Aula cancelada',
          body: `${tracked.title} — ${when(tracked)}.`,
          resourceType: 'calendar_event',
          resourceId: tracked.calendarEventId,
          version: 'published',
          institutionId: tracked.institutionId,
          data: this.eventLinks(tracked),
          urgency: 'high',
        }
      : {
          category: ANNOUNCEMENT_TYPES.has(tracked.type) ? 'deadline_change' : 'new_assessment',
          title: ANNOUNCEMENT_TYPES.has(tracked.type) ? label : `Nova avaliação/prazo: ${label}`,
          body: `${tracked.title} — ${when(tracked)}.`,
          resourceType: 'calendar_event',
          resourceId: tracked.calendarEventId,
          version: 'published',
          institutionId: tracked.institutionId,
          data: this.eventLinks(tracked),
          urgency: 'normal',
        };
    return this.fanOut(tracked.classSectionId, draft);
  }

  private async onUpdated(event: EventEnvelope): Promise<FanOutResult> {
    const details = await this.resolveEvent(event);
    if (!details)
      return {
        category: null,
        created: 0,
        duplicates: 0,
        recipients: 0,
        skippedReason: 'event_not_found',
      };
    const previous = await this.deps.store.getTrackedEvent(details.id);
    const next = this.toTracked(details, previous?.extractedEventId ?? str(event.data.eventId));
    const cancelled =
      next.status === 'cancelled' ||
      event.type === 'event.cancelled' ||
      event.type === 'calendar.event_cancelled';
    if (cancelled) next.status = 'cancelled';
    await this.deps.store.saveTrackedEvent(next);

    if (cancelled && previous?.status !== 'cancelled') {
      const isClass = next.type === 'class_cancellation' || next.type === 'class_reschedule';
      return this.fanOut(next.classSectionId, {
        category: 'class_cancellation',
        title: isClass ? 'Aula cancelada' : `Cancelado: ${TYPE_LABEL[next.type] ?? 'Evento'}`,
        body: `${next.title} (${when(next)}) foi cancelado.`,
        resourceType: 'calendar_event',
        resourceId: next.calendarEventId,
        version: `cancelled:${next.version}`,
        institutionId: next.institutionId,
        data: this.eventLinks(next),
        urgency: 'high',
      });
    }
    const dateChanged =
      previous !== undefined &&
      (previous.eventDate !== next.eventDate ||
        (previous.eventTime ?? null) !== (next.eventTime ?? null));
    if (!dateChanged || cancelled) {
      return {
        category: null,
        created: 0,
        duplicates: 0,
        recipients: 0,
        skippedReason: previous ? 'no_date_change' : 'untracked_event',
      };
    }
    return this.fanOut(next.classSectionId, {
      category: 'deadline_change',
      title: `Prazo alterado: ${TYPE_LABEL[next.type] ?? 'Evento'}`,
      body: `${next.title}: de ${when(previous)} para ${when(next)}.`,
      resourceType: 'calendar_event',
      resourceId: next.calendarEventId,
      version: `date:${next.eventDate}T${next.eventTime ?? ''}`,
      institutionId: next.institutionId,
      data: {
        ...this.eventLinks(next),
        previousEventDate: previous.eventDate,
        previousEventTime: previous.eventTime,
      },
      urgency: 'high',
    });
  }

  private async onLectureStructured(event: EventEnvelope): Promise<FanOutResult> {
    const d = event.data;
    const scheduledClassId = str(d.scheduledClassId);
    const lectureSummaryId = str(d.lectureSummaryId) ?? str(d.transcriptId);
    if (!scheduledClassId || !lectureSummaryId) {
      return {
        category: null,
        created: 0,
        duplicates: 0,
        recipients: 0,
        skippedReason: 'missing_ids',
      };
    }
    let classSectionId = str(d.classSectionId);
    let localDate: string | null = null;
    if (!classSectionId) {
      const sc = await this.deps.classes.getScheduledClass(scheduledClassId);
      classSectionId = sc?.classSectionId ?? null;
      localDate = sc?.localDate ?? null;
    }
    if (!classSectionId) {
      return {
        category: 'lecture_summary',
        created: 0,
        duplicates: 0,
        recipients: 0,
        skippedReason: 'class_not_found',
      };
    }
    return this.fanOut(classSectionId, {
      category: 'lecture_summary',
      title: 'Resumo da aula disponível',
      body: localDate
        ? `O resumo da aula de ${brDate(localDate)} já pode ser consultado.`
        : 'O resumo da aula já pode ser consultado.',
      resourceType: 'lecture_summary',
      resourceId: lectureSummaryId,
      // one notification per lecture summary, even if it is re-structured later
      version: '1',
      institutionId: event.institutionId ?? null,
      data: {
        scheduledClassId,
        lectureSummaryId,
        transcriptId: str(d.transcriptId),
        url: this.link(studentWebPath(scheduledClassId, 'scheduled_class')),
      },
      urgency: 'normal',
    });
  }

  private link(path: string): string | null {
    return this.deps.studentWebUrl ? `${this.deps.studentWebUrl.replace(/\/$/, '')}${path}` : path;
  }

  private eventLinks(e: TrackedEvent): Record<string, unknown> {
    return {
      calendarEventId: e.calendarEventId,
      extractedEventId: e.extractedEventId,
      classSectionId: e.classSectionId,
      eventType: e.type,
      eventDate: e.eventDate,
      eventTime: e.eventTime,
      url: this.link(studentWebPath(e.calendarEventId, 'calendar_event')),
    };
  }

  // ------------------------------------------------------------------ reminders
  /**
   * Computes due reminders. For each active assessment and each enrolled student, the
   * reminder for the *smallest* offset whose time has come is sent (once, deduplicated),
   * so a late publication never causes a burst of stale reminders.
   */
  async runReminders(
    now: Date,
  ): Promise<{ created: number; duplicates: number; events: number; flushed: number }> {
    const today = now.toISOString().slice(0, 10);
    const events = await this.deps.store.listTrackedEvents({
      status: 'active',
      fromDate: addDays(today, -1),
      toDate: addDays(today, 8),
    });
    let created = 0;
    let duplicates = 0;
    let considered = 0;
    for (const ev of events) {
      if (!REMINDER_TYPES.has(ev.type)) continue;
      const at = zonedToUtc(ev.eventDate, ev.eventTime ?? DEFAULT_EVENT_TIME, ev.timezone);
      if (at.getTime() <= now.getTime()) continue;
      considered += 1;
      for (const recipient of await this.deps.enrollments.activeRecipients(ev.classSectionId)) {
        const prefs = await this.preferencesOf(recipient.userId);
        const due = prefs.reminderOffsetsHours.filter(
          (h) => at.getTime() - h * 3_600_000 <= now.getTime(),
        );
        if (due.length === 0) continue;
        const offset = Math.min(...due);
        const hoursLeft = Math.max(1, Math.round((at.getTime() - now.getTime()) / 3_600_000));
        const label = TYPE_LABEL[ev.type] ?? 'Evento';
        const outcome = await this.deliverTo(
          recipient,
          prefs,
          {
            category: 'reminder',
            title: `Lembrete: ${label} ${hoursLeft >= 20 ? 'amanhã' : `em ${hoursLeft} h`}`,
            body: `${ev.title} — ${when(ev)}.`,
            resourceType: 'calendar_event',
            resourceId: ev.calendarEventId,
            // a new date produces new reminders; the same offset is never repeated
            version: `reminder:${ev.eventDate}T${ev.eventTime ?? ''}:${offset}h`,
            institutionId: ev.institutionId,
            data: { ...this.eventLinks(ev), offsetHours: offset },
            urgency: offset <= 2 ? 'high' : 'normal',
          },
          now,
        );
        if (outcome === 'created') created += 1;
        else duplicates += 1;
      }
    }
    const flushed = await this.flushDeferred(now);
    return { created, duplicates, events: considered, flushed };
  }

  // ------------------------------------------------------------------ delivery
  async preferencesOf(userId: string): Promise<NotificationPreferences> {
    return (await this.deps.store.getPreferences(userId)) ?? defaultPreferences(userId);
  }

  private async fanOut(classSectionId: string, draft: Draft): Promise<FanOutResult> {
    const now = this.deps.clock();
    const recipients = await this.deps.enrollments.activeRecipients(classSectionId);
    let created = 0;
    let duplicates = 0;
    for (const recipient of recipients) {
      const prefs = await this.preferencesOf(recipient.userId);
      const outcome = await this.deliverTo(recipient, prefs, draft, now);
      if (outcome === 'created') created += 1;
      else duplicates += 1;
    }
    this.deps.logger.info(
      {
        category: draft.category,
        resourceId: draft.resourceId,
        classSectionId,
        created,
        duplicates,
      },
      'student notifications fanned out',
    );
    return { category: draft.category, created, duplicates, recipients: recipients.length };
  }

  private async deliverTo(
    recipient: Recipient,
    prefs: NotificationPreferences,
    draft: Draft,
    now: Date,
  ): Promise<'created' | 'duplicate'> {
    const toggles = prefs.categories[draft.category];
    const notification: UserNotification = {
      id: randomUUID(),
      userId: recipient.userId,
      institutionId: draft.institutionId ?? recipient.institutionId,
      category: draft.category,
      title: draft.title,
      body: draft.body,
      resourceType: draft.resourceType,
      resourceId: draft.resourceId,
      version: draft.version,
      dedupeKey: dedupeKeyOf(recipient.userId, draft.category, draft.resourceId, draft.version),
      data: { ...draft.data, urgency: draft.urgency },
      inApp: toggles.in_app,
      createdAt: now.toISOString(),
      readAt: null,
    };
    if (!(await this.deps.store.insertNotification(notification))) return 'duplicate';

    const at = now.toISOString();
    if (toggles.in_app) {
      await this.deps.store.addDelivery({
        notificationId: notification.id,
        userId: recipient.userId,
        channel: 'in_app',
        status: 'sent',
        detail: null,
        attemptedAt: at,
      });
    }
    const quietEnd = quietUntil(prefs.quietHours, now);
    for (const channel of ['email', 'push'] as const) {
      if (!toggles[channel]) continue;
      if (quietEnd) {
        await this.deps.store.addDeferred({
          id: randomUUID(),
          notificationId: notification.id,
          userId: recipient.userId,
          channel,
          dueAt: quietEnd.toISOString(),
          createdAt: at,
        });
        await this.deps.store.addDelivery({
          notificationId: notification.id,
          userId: recipient.userId,
          channel,
          status: 'deferred',
          detail: `quiet hours until ${quietEnd.toISOString()}`,
          attemptedAt: at,
        });
        continue;
      }
      await this.send(channel, notification, recipient, now);
    }
    return 'created';
  }

  /** Delivers deferred email/push whose quiet window has ended. */
  async flushDeferred(now: Date): Promise<number> {
    let flushed = 0;
    for (;;) {
      const batch = await this.deps.store.takeDueDeferred(now.toISOString(), 500);
      if (batch.length === 0) break;
      for (const item of batch) {
        const notification = await this.deps.store.getNotification(item.notificationId);
        if (!notification) continue;
        const prefs = await this.preferencesOf(item.userId);
        // the user may have turned the channel off (or extended quiet hours) meanwhile
        if (!prefs.categories[notification.category][item.channel]) continue;
        const stillQuiet = quietUntil(prefs.quietHours, now);
        if (stillQuiet) {
          await this.deps.store.addDeferred({
            ...item,
            id: randomUUID(),
            dueAt: stillQuiet.toISOString(),
          });
          continue;
        }
        const recipient = await this.recipientOf(notification);
        await this.send(item.channel, notification, recipient, now);
        flushed += 1;
      }
    }
    return flushed;
  }

  private async recipientOf(n: UserNotification): Promise<Recipient> {
    const classSectionId = typeof n.data.classSectionId === 'string' ? n.data.classSectionId : null;
    if (classSectionId) {
      const match = (await this.deps.enrollments.activeRecipients(classSectionId)).find(
        (r) => r.userId === n.userId,
      );
      if (match) return match;
    }
    return {
      userId: n.userId,
      studentId: n.userId,
      institutionId: n.institutionId ?? '',
      email: null,
    };
  }

  private async send(
    channel: DeferrableChannel,
    n: UserNotification,
    recipient: Recipient,
    now: Date,
  ): Promise<void> {
    const record = async (
      status: 'sent' | 'failed' | 'skipped',
      detail: string | null,
    ): Promise<void> =>
      this.deps.store.addDelivery({
        notificationId: n.id,
        userId: n.userId,
        channel,
        status,
        detail,
        attemptedAt: now.toISOString(),
      });
    if (channel === 'email') {
      if (!recipient.email) return record('skipped', 'no_email_address');
      try {
        await this.deps.email.send({
          to: recipient.email,
          subject: n.title,
          text: [n.body, typeof n.data.url === 'string' ? `\n${n.data.url}` : null]
            .filter(Boolean)
            .join('\n'),
          metadata: { notificationId: n.id, category: n.category, userId: n.userId },
        });
        return record('sent', null);
      } catch (err) {
        return record('failed', err instanceof Error ? err.message : String(err));
      }
    }
    const subscriptions = await this.deps.store.listPushSubscriptions(n.userId);
    if (subscriptions.length === 0) return record('skipped', 'no_push_subscription');
    for (const sub of subscriptions) {
      try {
        const result = await this.deps.push.send(
          { endpoint: sub.endpoint, keys: sub.keys },
          {
            title: n.title,
            body: n.body,
            tag: `${n.category}:${n.resourceId}`,
            data: { notificationId: n.id, category: n.category, ...n.data },
            ...(typeof n.data.url === 'string' ? { url: n.data.url } : {}),
          },
          {
            ttlSeconds: n.category === 'reminder' ? 6 * 3600 : 24 * 3600,
            urgency: n.data.urgency === 'high' ? 'high' : 'normal',
            topic: n.resourceId.replace(/-/g, '').slice(0, 32),
          },
        );
        if (result.expired) {
          await this.deps.store.deletePushSubscription(n.userId, sub.id);
          await record('failed', `subscription expired (${result.statusCode}); removed`);
        } else {
          await this.deps.store.updatePushSubscription({
            ...sub,
            lastSuccessAt: now.toISOString(),
            failureCount: 0,
          });
          await record('sent', sub.id);
        }
      } catch (err) {
        await this.deps.store.updatePushSubscription({
          ...sub,
          failureCount: sub.failureCount + 1,
        });
        await record('failed', err instanceof Error ? err.message : String(err));
      }
    }
  }
}
