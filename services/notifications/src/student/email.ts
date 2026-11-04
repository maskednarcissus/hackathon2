export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** HTTP mail relay (SendGrid/internal): `POST <url> {to, subject, text, metadata}`. */
export class WebhookEmailSender implements EmailSender {
  constructor(
    private readonly url: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`mail relay responded ${res.status}`);
  }
}

export class InMemoryEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  failWith: string | null = null;
  send(message: EmailMessage): Promise<void> {
    if (this.failWith) return Promise.reject(new Error(this.failWith));
    this.sent.push(message);
    return Promise.resolve();
  }
}
