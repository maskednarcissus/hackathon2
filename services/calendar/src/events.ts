/**
 * Event bus publishing (integration stage §2). Envelope = Phase 1 contract §6; topic = event type.
 * `EVENT_BUS_URL` set → POST {EVENT_BUS_URL}/v1/topics/{type}:publish (header x-internal-token);
 * otherwise in-memory (dev/tests). Publishing failures are logged and never fail the API call:
 * the calendar row is the source of truth and the event can be replayed from it.
 */
import { randomUUID } from 'node:crypto';
import type { CalendarEvent, CalendarEventChange, Conflict, SectionRecord } from './domain.js';

export type CalendarEventType = 'calendar.event_published' | 'calendar.event_updated';

export interface EventEnvelope<T = unknown> {
  eventId: string;
  type: string;
  version: 1;
  occurredAt: string;
  source: 'calendar';
  institutionId: string;
  data: T;
}

/** Full event inline, so subscribers (notifications) never need to call back. */
export interface CalendarEventPayload {
  calendarEventId: string;
  event: CalendarEvent;
  section: {
    classSectionId: string;
    courseId: string;
    courseName: string | null;
    sectionCode: string | null;
  } | null;
  previousVersion: number | null;
  changes: CalendarEventChange[];
  conflicts: Conflict[];
}

export interface EventPublisher {
  publish(envelope: EventEnvelope): Promise<void>;
}

export interface PublisherLogger {
  warn(obj: unknown, msg?: string): void;
}

export function envelope<T>(
  type: string,
  institutionId: string,
  data: T,
  occurredAt: Date,
): EventEnvelope<T> {
  return {
    eventId: randomUUID(),
    type,
    version: 1,
    occurredAt: occurredAt.toISOString(),
    source: 'calendar',
    institutionId,
    data,
  };
}

export function calendarPayload(
  event: CalendarEvent,
  section: SectionRecord | undefined,
  previousVersion: number | null,
  changes: CalendarEventChange[],
  conflicts: Conflict[],
): CalendarEventPayload {
  return {
    calendarEventId: event.id,
    event,
    section: section
      ? {
          classSectionId: section.classSectionId,
          courseId: section.courseId,
          courseName: section.courseName,
          sectionCode: section.sectionCode,
        }
      : null,
    previousVersion,
    changes,
    conflicts,
  };
}

export class HttpEventBusPublisher implements EventPublisher {
  constructor(
    private readonly baseUrl: string,
    private readonly logger: PublisherLogger,
    private readonly options: {
      internalToken?: string | undefined;
      fetch?: typeof fetch;
      timeoutMs?: number;
    } = {},
  ) {}

  async publish(env: EventEnvelope): Promise<void> {
    const doFetch = this.options.fetch ?? globalThis.fetch;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.options.internalToken) headers['x-internal-token'] = this.options.internalToken;
    const url = `${this.baseUrl.replace(/\/$/, '')}/v1/topics/${encodeURIComponent(env.type)}:publish`;
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(env),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 3000),
      });
      if (!res.ok) {
        this.logger.warn(
          { status: res.status, type: env.type, eventId: env.eventId },
          'event rejected',
        );
      }
    } catch (err) {
      this.logger.warn({ err, type: env.type, eventId: env.eventId }, 'event bus unreachable');
    }
  }
}

export class InMemoryEventPublisher implements EventPublisher {
  readonly published: EventEnvelope[] = [];
  async publish(env: EventEnvelope): Promise<void> {
    this.published.push(env);
  }
}
