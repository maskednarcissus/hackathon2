/**
 * Event publication (integration-stage contract §2). Vendored in every TS service — keep in sync.
 * EVENT_BUS_URL set → HTTP publisher `POST {EVENT_BUS_URL}/v1/topics/{type}:publish` (x-internal-token).
 */
import { randomUUID } from 'node:crypto';

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

export class LoggingEventPublisher implements EventPublisher {
  constructor(private readonly log: (event: EventEnvelope) => void) {}
  publish(event: EventEnvelope): Promise<void> {
    this.log(event);
    return Promise.resolve();
  }
}

export class EventBusError extends Error {}

export class HttpEventBusPublisher implements EventPublisher {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string | undefined,
    private readonly options: {
      timeoutMs?: number;
      attempts?: number;
      backoffMs?: number;
      fetch?: typeof fetch;
    } = {},
  ) {}

  async publish(event: EventEnvelope): Promise<void> {
    const doFetch = this.options.fetch ?? globalThis.fetch;
    const attempts = this.options.attempts ?? 3;
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await doFetch(
          `${this.baseUrl}/v1/topics/${encodeURIComponent(event.type)}:publish`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(this.internalToken ? { 'x-internal-token': this.internalToken } : {}),
            },
            body: JSON.stringify(event),
            signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
          },
        );
        if (res.ok) return;
        lastError = new EventBusError(`event bus returned ${res.status}`);
        if (res.status < 500 && res.status !== 429) break; // not retryable
      } catch (err) {
        lastError = err;
      }
      if (i < attempts - 1)
        await new Promise((r) => setTimeout(r, (this.options.backoffMs ?? 200) * 2 ** i));
    }
    throw lastError instanceof Error ? lastError : new EventBusError(String(lastError));
  }
}

/** Picks the publisher from the environment: EVENT_BUS_URL → HTTP, otherwise logging. */
export function publisherFromEnv(
  env: NodeJS.ProcessEnv,
  log: (event: EventEnvelope) => void,
): EventPublisher {
  if (env['EVENT_BUS_URL'])
    return new HttpEventBusPublisher(env['EVENT_BUS_URL'], env['INTERNAL_API_TOKEN']);
  return new LoggingEventPublisher(log);
}
