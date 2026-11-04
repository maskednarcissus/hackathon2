import { HttpAuditClient, InMemoryAuditClient } from './audit.js';
import {
  ConsoleChannel,
  RecipientDirectory,
  WebhookChannel,
  WebhookEmailChannel,
  type NotificationChannel,
} from './channels.js';
import { buildApp } from './app.js';

const env = process.env;

const channels: NotificationChannel[] = [
  new ConsoleChannel((msg, obj) => console.log(msg, JSON.stringify(obj))),
  new WebhookChannel(),
];
if (env.MAIL_RELAY_URL)
  channels.push(new WebhookEmailChannel(env.MAIL_RELAY_URL, env.MAIL_RELAY_TOKEN));

const { app } = buildApp({
  logger: true,
  channels,
  // ALERT_RECIPIENTS_JSON: {"default":[{"channel":"email","address":"ops@x","minSeverity":"medium"}],
  //                         "institutions":{"<uuid>":[...]}}
  recipients: RecipientDirectory.fromJson(env.ALERT_RECIPIENTS_JSON),
  audit: env.AUDIT_URL ? new HttpAuditClient(env.AUDIT_URL) : new InMemoryAuditClient(),
});

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: Number(env.PORT ?? 4006), host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
