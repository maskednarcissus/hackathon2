import { randomUUID } from 'node:crypto';

/** Pub/Sub envelope (phase-1 contract §6). */
export interface EventEnvelope<T = Record<string, unknown>> {
  eventId: string;
  type: string;
  version: number;
  occurredAt: string;
  source: string;
  institutionId: string | null;
  data: T;
}

export interface EventPublisher {
  publish(event: EventEnvelope): Promise<void>;
}

export function envelope(
  type: string,
  source: string,
  institutionId: string | null,
  data: Record<string, unknown>,
  occurredAt: Date = new Date(),
): EventEnvelope {
  return {
    eventId: randomUUID(),
    type,
    version: 1,
    occurredAt: occurredAt.toISOString(),
    source,
    institutionId,
    data,
  };
}

export class InMemoryEventPublisher implements EventPublisher {
  readonly events: EventEnvelope[] = [];
  publish(event: EventEnvelope): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

/** Dev/default publisher: writes events to the log. Production wires a Pub/Sub adapter. */
export class LoggingEventPublisher implements EventPublisher {
  constructor(private readonly log: (event: EventEnvelope) => void) {}
  publish(event: EventEnvelope): Promise<void> {
    this.log(event);
    return Promise.resolve();
  }
}
