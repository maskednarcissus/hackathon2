import { randomUUID } from 'node:crypto';
import type { AuditClient } from './audit.js';
import { detectConflicts } from './conflicts.js';
import type {
  CalendarEvent,
  CalendarEventChange,
  ChangeSource,
  ChangeType,
  Conflict,
} from './domain.js';
import { AppError, notFound } from './errors.js';
import {
  calendarPayload,
  envelope,
  InMemoryEventPublisher,
  type EventPublisher,
} from './events.js';
import { VersionConflictError, type CalendarRepository } from './repository.js';
import type { CreateCalendarEventInput } from './schemas.js';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface PublishResult {
  event: CalendarEvent;
  created: boolean;
  changes: CalendarEventChange[];
  conflicts: Conflict[];
}

type TrackedField =
  'eventDate' | 'eventTime' | 'timezone' | 'title' | 'description' | 'type' | 'isOfficial';

const FIELD_CHANGE_TYPE: Record<TrackedField, ChangeType> = {
  eventDate: 'date_change',
  eventTime: 'date_change',
  timezone: 'date_change',
  title: 'description_change',
  description: 'description_change',
  type: 'other',
  isOfficial: 'status_change',
};

const str = (v: string | boolean | null): string | null => (v === null ? null : String(v));

export class CalendarService {
  constructor(
    private readonly repo: CalendarRepository,
    private readonly audit: AuditClient,
    private readonly clock: Clock,
    private readonly events: EventPublisher = new InMemoryEventPublisher(),
  ) {}

  private async emit(
    type: 'calendar.event_published' | 'calendar.event_updated',
    event: CalendarEvent,
    previousVersion: number | null,
    changes: CalendarEventChange[],
    conflicts: Conflict[],
  ): Promise<void> {
    const section = await this.repo.getSection(event.classSectionId);
    await this.events.publish(
      envelope(
        type,
        event.institutionId,
        calendarPayload(event, section, previousVersion, changes, conflicts),
        this.clock.now(),
      ),
    );
  }

  private async saveVersion(
    event: CalendarEvent,
    changes: CalendarEventChange[],
    expectedVersion: number,
  ): Promise<void> {
    try {
      await this.repo.updateEventWithChanges(event, changes, expectedVersion);
    } catch (err) {
      if (err instanceof VersionConflictError) {
        throw new AppError(
          409,
          'concurrent_update',
          'The calendar event was modified concurrently; retry',
        );
      }
      throw err;
    }
  }

  async publish(input: CreateCalendarEventInput): Promise<PublishResult> {
    const nowIso = this.clock.now().toISOString();
    const existing =
      input.extractedEventId !== undefined
        ? await this.repo.findByExtractedEventId(input.extractedEventId)
        : undefined;

    const next: Omit<CalendarEvent, 'id' | 'version' | 'createdAt' | 'updatedAt'> = {
      institutionId: input.institutionId,
      courseId: input.courseId,
      classSectionId: input.classSectionId,
      extractedEventId: input.extractedEventId ?? null,
      type: input.type,
      title: input.title,
      description: input.description ?? null,
      eventDate: input.eventDate,
      eventTime: input.eventTime ?? null,
      timezone: input.timezone,
      isOfficial: input.isOfficial,
      status: 'published',
      provenance: input.provenance ?? null,
    };

    if (!existing) {
      const event: CalendarEvent = {
        ...next,
        id: randomUUID(),
        version: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const conflicts = await detectConflicts(this.repo, {
        institutionId: event.institutionId,
        classSectionId: event.classSectionId,
        type: event.type,
        eventDate: event.eventDate,
        eventTime: event.eventTime ?? undefined,
      });
      try {
        await this.repo.insertEvent(event);
      } catch (err) {
        // Postgres: unique extracted_event_id lost a race with a concurrent first publish.
        if (err instanceof VersionConflictError) {
          throw new AppError(
            409,
            'concurrent_update',
            'The calendar event was published concurrently; retry',
          );
        }
        throw err;
      }
      await this.audit.record({
        tenantId: event.institutionId,
        ...(input.changedBy !== undefined ? { actorId: input.changedBy } : {}),
        actorType:
          input.changeSource === 'system' || input.changeSource === 'integration'
            ? 'system'
            : input.changeSource,
        action: 'calendar.event_published',
        resourceType: 'calendar_event',
        resourceId: event.id,
        metadata: {
          extractedEventId: event.extractedEventId,
          classSectionId: event.classSectionId,
          type: event.type,
          eventDate: event.eventDate,
          conflictKinds: conflicts.map((c) => c.kind),
        },
      });
      await this.emit('calendar.event_published', event, null, [], conflicts);
      return { event, created: true, changes: [], conflicts };
    }

    if (
      existing.institutionId !== next.institutionId ||
      existing.classSectionId !== next.classSectionId
    ) {
      throw new AppError(
        409,
        'ownership_mismatch',
        'An extracted event cannot be moved to another institution or class section',
      );
    }

    const changes: CalendarEventChange[] = [];
    const mk = (
      changeType: ChangeType,
      field: string,
      previousValue: string | null,
      newValue: string | null,
    ): CalendarEventChange => ({
      id: randomUUID(),
      calendarEventId: existing.id,
      changedAt: nowIso,
      changedBy: input.changedBy ?? null,
      source: input.changeSource,
      changeType,
      field,
      previousValue,
      newValue,
      reason: input.changeReason ?? null,
    });

    for (const field of Object.keys(FIELD_CHANGE_TYPE) as TrackedField[]) {
      const before = existing[field];
      const after = next[field];
      if (before !== after)
        changes.push(mk(FIELD_CHANGE_TYPE[field], field, str(before), str(after)));
    }
    if (existing.status === 'cancelled') {
      changes.push(mk('status_change', 'status', 'cancelled', 'published'));
    }

    if (
      changes.length === 0 &&
      JSON.stringify(existing.provenance) === JSON.stringify(next.provenance)
    ) {
      const conflicts = await this.conflictsFor(existing);
      return { event: existing, created: false, changes: [], conflicts };
    }

    const updated: CalendarEvent = {
      ...existing,
      ...next,
      version: existing.version + 1,
      updatedAt: nowIso,
    };
    const conflicts = await this.conflictsFor(updated);
    await this.saveVersion(updated, changes, existing.version);
    await this.audit.record({
      tenantId: updated.institutionId,
      ...(input.changedBy !== undefined ? { actorId: input.changedBy } : {}),
      actorType:
        input.changeSource === 'system' || input.changeSource === 'integration'
          ? 'system'
          : input.changeSource,
      action: 'calendar.event_updated',
      resourceType: 'calendar_event',
      resourceId: updated.id,
      metadata: {
        extractedEventId: updated.extractedEventId,
        version: updated.version,
        changedFields: changes.map((c) => c.field),
      },
    });
    await this.emit('calendar.event_updated', updated, existing.version, changes, conflicts);
    return { event: updated, created: false, changes, conflicts };
  }

  async cancel(
    id: string,
    actorId: string,
    reason: string,
    source: ChangeSource,
  ): Promise<{ event: CalendarEvent; change: CalendarEventChange | null }> {
    const existing = await this.repo.getEvent(id);
    if (!existing) throw notFound('Calendar event', id);
    if (existing.status === 'cancelled') return { event: existing, change: null };
    const nowIso = this.clock.now().toISOString();
    const updated: CalendarEvent = {
      ...existing,
      status: 'cancelled',
      version: existing.version + 1,
      updatedAt: nowIso,
    };
    const change: CalendarEventChange = {
      id: randomUUID(),
      calendarEventId: id,
      changedAt: nowIso,
      changedBy: actorId,
      source,
      changeType: 'cancellation',
      field: 'status',
      previousValue: existing.status,
      newValue: 'cancelled',
      reason,
    };
    await this.saveVersion(updated, [change], existing.version);
    await this.audit.record({
      tenantId: updated.institutionId,
      actorId,
      actorType: source === 'system' || source === 'integration' ? 'system' : source,
      action: 'calendar.event_updated',
      resourceType: 'calendar_event',
      resourceId: id,
      metadata: { version: updated.version, changedFields: ['status'], status: 'cancelled' },
    });
    await this.emit('calendar.event_updated', updated, existing.version, [change], []);
    return { event: updated, change };
  }

  private conflictsFor(e: CalendarEvent): Promise<Conflict[]> {
    return detectConflicts(this.repo, {
      institutionId: e.institutionId,
      classSectionId: e.classSectionId,
      type: e.type,
      eventDate: e.eventDate,
      eventTime: e.eventTime ?? undefined,
      excludeEventId: e.id,
    });
  }
}
