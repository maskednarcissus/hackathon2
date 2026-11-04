import type { Alert, Severity } from './domain.js';
import { SEVERITY_RANK } from './domain.js';

export interface AlertNotification {
  alert: Alert;
  kind: 'raised' | 'reminder' | 'escalated' | 'resolved';
  recipient: string;
  subject: string;
  text: string;
}

/** Delivery channel port (email relay, chat webhook, push…). */
export interface NotificationChannel {
  readonly name: string;
  send(notification: AlertNotification): Promise<void>;
}

export interface Recipient {
  channel: string;
  address: string;
  /** Only alerts at or above this severity are delivered. */
  minSeverity: Severity;
}

/** Recipients per institution, with a fallback list for unknown/null institutions. */
export class RecipientDirectory {
  constructor(
    private readonly byInstitution: Record<string, Recipient[]> = {},
    private readonly fallback: Recipient[] = [],
  ) {}

  static fromJson(json: string | undefined): RecipientDirectory {
    if (!json) return new RecipientDirectory();
    const parsed = JSON.parse(json) as {
      default?: Recipient[];
      institutions?: Record<string, Recipient[]>;
    };
    return new RecipientDirectory(parsed.institutions ?? {}, parsed.default ?? []);
  }

  recipientsFor(institutionId: string | null, severity: Severity): Recipient[] {
    const list = (institutionId ? this.byInstitution[institutionId] : undefined) ?? this.fallback;
    return list.filter((r) => SEVERITY_RANK[severity] >= SEVERITY_RANK[r.minSeverity]);
  }
}

/**
 * Email through an HTTP mail relay (e.g. SendGrid / internal relay):
 * `POST <url>` `{ to, subject, text }` with optional bearer token.
 */
export class WebhookEmailChannel implements NotificationChannel {
  readonly name = 'email';

  constructor(
    private readonly url: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(n: AlertNotification): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        to: n.recipient,
        subject: n.subject,
        text: n.text,
        metadata: { alertId: n.alert.id, rule: n.alert.rule, kind: n.kind },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`mail relay responded ${res.status}`);
  }
}

/** Generic JSON webhook (chat/on-call tools). */
export class WebhookChannel implements NotificationChannel {
  readonly name = 'webhook';

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async send(n: AlertNotification): Promise<void> {
    const res = await this.fetchImpl(n.recipient, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: n.kind, subject: n.subject, text: n.text, alert: n.alert }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  }
}

export class ConsoleChannel implements NotificationChannel {
  readonly name = 'console';
  constructor(private readonly log: (msg: string, obj: object) => void) {}
  send(n: AlertNotification): Promise<void> {
    this.log(`[alert:${n.kind}] ${n.subject}`, { recipient: n.recipient, alertId: n.alert.id });
    return Promise.resolve();
  }
}

export class InMemoryChannel implements NotificationChannel {
  readonly sent: AlertNotification[] = [];
  constructor(
    readonly name = 'memory',
    private readonly failWith?: string,
  ) {}
  send(n: AlertNotification): Promise<void> {
    if (this.failWith) return Promise.reject(new Error(this.failWith));
    this.sent.push(n);
    return Promise.resolve();
  }
}
