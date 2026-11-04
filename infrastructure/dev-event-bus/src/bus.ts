import { randomUUID } from 'node:crypto';

import { resolveEndpoint, type RoutingTable, type Subscription } from './subscriptions.js';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface BusOptions {
  routes: RoutingTable;
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  internalToken?: string | undefined;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (msg: string, data: Record<string, unknown>) => void;
  /** Max entries kept in the delivery log and the dead-letter list. */
  historyLimit?: number;
}

export interface Envelope {
  eventId: string;
  type: string;
  [key: string]: unknown;
}

export type DeliveryStatus = 'delivered' | 'dead_lettered' | 'skipped';

export interface DeliveryRecord {
  deliveryId: string;
  messageId: string;
  eventId: string;
  topic: string;
  subscription: string;
  endpoint: string | null;
  status: DeliveryStatus;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  /** First 500 characters of the subscriber's last response body (debugging aid). */
  lastResponse: string | null;
  firstAttemptAt: string;
  finishedAt: string;
}

export interface DeadLetter extends DeliveryRecord {
  envelope: Envelope;
}

export interface PublishResult {
  messageId: string;
  topic: string;
  subscriptions: string[];
  deliveries?: DeliveryRecord[];
}

/** 4xx other than 408/429 cannot succeed on retry: dead-letter straight away. */
function isPermanent(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export class EventBus {
  private readonly deliveries: DeliveryRecord[] = [];
  private readonly deadLetters: DeadLetter[] = [];
  private readonly inflight = new Set<Promise<DeliveryRecord>>();
  private readonly o: Required<Omit<BusOptions, 'internalToken'>> & {
    internalToken?: string | undefined;
  };

  constructor(options: BusOptions) {
    this.o = {
      maxAttempts: 5,
      baseBackoffMs: 200,
      maxBackoffMs: 10_000,
      timeoutMs: 30_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => new Date(),
      log: () => undefined,
      historyLimit: 1000,
      ...options,
      ...(options.internalToken ? { internalToken: options.internalToken } : {}),
    };
  }

  topics(): { topic: string; subscriptions: (Subscription & { endpoint: string | null })[] }[] {
    return [...this.o.routes.entries()].map(([topic, subs]) => ({
      topic,
      subscriptions: subs.map((s) => ({ ...s, endpoint: resolveEndpoint(s, this.o.env) ?? null })),
    }));
  }

  hasTopic(topic: string): boolean {
    return this.o.routes.has(topic);
  }

  /** Fans the envelope out to every subscription. With `wait`, resolves after all deliveries end. */
  async publish(topic: string, envelope: Envelope, wait = false): Promise<PublishResult> {
    const subs = this.o.routes.get(topic) ?? [];
    const messageId = randomUUID();
    const publishTime = this.o.now().toISOString();
    const runs = subs.map((sub) => {
      const p = this.deliver(topic, sub, envelope, messageId, publishTime);
      this.inflight.add(p);
      void p.finally(() => this.inflight.delete(p));
      return p;
    });
    const result: PublishResult = { messageId, topic, subscriptions: subs.map((s) => s.name) };
    if (wait) result.deliveries = await Promise.all(runs);
    return result;
  }

  /** Waits for every in-flight delivery (tests, graceful shutdown). */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  recentDeliveries(limit = 100): DeliveryRecord[] {
    return this.deliveries.slice(-limit).reverse();
  }

  listDeadLetters(): DeadLetter[] {
    return [...this.deadLetters].reverse();
  }

  clearDeadLetters(): number {
    const n = this.deadLetters.length;
    this.deadLetters.length = 0;
    return n;
  }

  /** Re-delivers one dead letter to its subscription; removes it from the list on success. */
  async replay(deliveryId: string): Promise<DeliveryRecord | undefined> {
    const idx = this.deadLetters.findIndex((d) => d.deliveryId === deliveryId);
    const dl = this.deadLetters[idx];
    if (!dl) return undefined;
    const sub = this.o.routes.get(dl.topic)?.find((s) => s.name === dl.subscription);
    if (!sub) return undefined;
    this.deadLetters.splice(idx, 1);
    return this.deliver(dl.topic, sub, dl.envelope, dl.messageId, this.o.now().toISOString());
  }

  private pushBody(
    topic: string,
    sub: Subscription,
    envelope: Envelope,
    messageId: string,
    publishTime: string,
  ): string {
    return JSON.stringify({
      message: {
        data: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64'),
        messageId,
        message_id: messageId,
        publishTime,
        attributes: { type: envelope.type, eventId: envelope.eventId },
      },
      subscription: `projects/ci-dev/subscriptions/${topic}.${sub.name}`,
    });
  }

  private async deliver(
    topic: string,
    sub: Subscription,
    envelope: Envelope,
    messageId: string,
    publishTime: string,
  ): Promise<DeliveryRecord> {
    const endpoint = resolveEndpoint(sub, this.o.env) ?? null;
    const record: DeliveryRecord = {
      deliveryId: randomUUID(),
      messageId,
      eventId: envelope.eventId,
      topic,
      subscription: sub.name,
      endpoint,
      status: 'skipped',
      attempts: 0,
      lastStatusCode: null,
      lastError: null,
      lastResponse: null,
      firstAttemptAt: this.o.now().toISOString(),
      finishedAt: '',
    };
    if (!endpoint) {
      record.lastError = `no base URL configured for service "${sub.service}"`;
      return this.finish(record, envelope);
    }
    const body = this.pushBody(topic, sub, envelope, messageId, publishTime);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.o.internalToken) headers['x-internal-token'] = this.o.internalToken;

    for (let attempt = 1; attempt <= this.o.maxAttempts; attempt++) {
      record.attempts = attempt;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.o.timeoutMs);
      try {
        const res = await this.o.fetch(endpoint, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
        record.lastStatusCode = res.status;
        const text = await res.text().catch(() => '');
        record.lastResponse = text.slice(0, 500) || null;
        if (res.status >= 200 && res.status < 300) {
          record.status = 'delivered';
          record.lastError = null;
          return this.finish(record, envelope);
        }
        record.lastError = text.slice(0, 2000) || `HTTP ${res.status}`;
        if (isPermanent(res.status)) break;
      } catch (err) {
        record.lastStatusCode = null;
        record.lastError = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }
      if (attempt < this.o.maxAttempts) {
        const backoff = Math.min(this.o.baseBackoffMs * 2 ** (attempt - 1), this.o.maxBackoffMs);
        await this.o.sleep(backoff);
      }
    }
    record.status = 'dead_lettered';
    return this.finish(record, envelope);
  }

  private finish(record: DeliveryRecord, envelope: Envelope): DeliveryRecord {
    record.finishedAt = this.o.now().toISOString();
    this.deliveries.push(record);
    if (this.deliveries.length > this.o.historyLimit) this.deliveries.shift();
    if (record.status !== 'delivered') {
      this.deadLetters.push({ ...record, envelope });
      if (this.deadLetters.length > this.o.historyLimit) this.deadLetters.shift();
    }
    this.o.log(`delivery ${record.status}`, {
      topic: record.topic,
      subscription: record.subscription,
      eventId: record.eventId,
      attempts: record.attempts,
      statusCode: record.lastStatusCode,
      error: record.lastError,
      response: record.lastResponse,
    });
    return record;
  }
}
