import { HttpAuditClient, InMemoryAuditClient } from './audit.js';
import {
  ConsoleChannel,
  RecipientDirectory,
  WebhookChannel,
  WebhookEmailChannel,
  type NotificationChannel,
} from './channels.js';
import { buildApp } from './app.js';
import {
  HttpCalendarEventSource,
  HttpClassDirectory,
  MapCalendarEventSource,
  MapClassDirectory,
} from './student/directories.js';
import { InMemoryEmailSender, WebhookEmailSender } from './student/email.js';
import { FakePushSender, WebPushSender } from './student/webpush.js';
import { createPool } from './db.js';
import { HttpOrganizationClient } from './incidents/organization.js';
import { HttpAlertContextClient } from './integration.js';
import { PgAlertStore } from './store.pg.js';
import { PgStudentStore } from './student/store.pg.js';
import { createJwksAccessTokenVerifier } from './vendor/jwt-verify.js';

const env = process.env;

// Persistence (integration stage §1): DATABASE_URL → Postgres, unset → in-memory (dev/tests).
const pool = env.DATABASE_URL ? createPool(env.DATABASE_URL) : null;

const channels: NotificationChannel[] = [
  new ConsoleChannel((msg, obj) => console.log(msg, JSON.stringify(obj))),
  new WebhookChannel(),
];
if (env.MAIL_RELAY_URL) {
  channels.push(new WebhookEmailChannel(env.MAIL_RELAY_URL, env.MAIL_RELAY_TOKEN));
}

const vapid =
  env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
    ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }
    : null;

const { app } = buildApp({
  logger: true,
  ...(pool ? { store: new PgAlertStore(pool), studentStore: new PgStudentStore(pool) } : {}),
  ...(env.ACADEMIC_INTEGRATION_URL
    ? {
        alertContext: new HttpAlertContextClient(
          env.ACADEMIC_INTEGRATION_URL,
          env.INTERNAL_API_TOKEN,
        ),
      }
    : {}),
  channels,
  // ALERT_RECIPIENTS_JSON: {"default":[{"channel":"email","address":"ops@x","minSeverity":"medium"}],
  //                         "institutions":{"<uuid>":[...]}}
  recipients: RecipientDirectory.fromJson(env.ALERT_RECIPIENTS_JSON),
  audit: env.AUDIT_URL ? new HttpAuditClient(env.AUDIT_URL) : new InMemoryAuditClient(),
  calendar: env.CALENDAR_URL
    ? new HttpCalendarEventSource(env.CALENDAR_URL, env.SERVICE_TOKEN)
    : new MapCalendarEventSource(),
  classes: env.ACADEMIC_INTEGRATION_URL
    ? new HttpClassDirectory(env.ACADEMIC_INTEGRATION_URL, env.SERVICE_TOKEN)
    : new MapClassDirectory(),
  email: env.MAIL_RELAY_URL
    ? new WebhookEmailSender(env.MAIL_RELAY_URL, env.MAIL_RELAY_TOKEN)
    : new InMemoryEmailSender(),
  push: vapid
    ? new WebPushSender(vapid, env.VAPID_SUBJECT ?? 'mailto:suporte@classroom-intelligence.example')
    : new FakePushSender(),
  vapidPublicKey: vapid?.publicKey ?? null,
  ...(env.IDENTITY_URL
    ? {
        verifyToken: createJwksAccessTokenVerifier({
          jwksUrl: `${env.IDENTITY_URL.replace(/\/$/, '')}/.well-known/jwks.json`,
        }),
      }
    : {}),
  ...(env.INTERNAL_API_TOKEN ? { internalToken: env.INTERNAL_API_TOKEN } : {}),
  ...(env.ADMIN_API_TOKEN ? { adminToken: env.ADMIN_API_TOKEN } : {}),
  ...(env.ORGANIZATION_URL
    ? {
        organization: new HttpOrganizationClient(env.ORGANIZATION_URL, {
          token: env.SERVICE_TOKEN,
        }),
      }
    : {}),
  ...(env.STUDENT_WEB_URL ? { studentWebUrl: env.STUDENT_WEB_URL } : {}),
});

if (!env.INTERNAL_API_TOKEN) {
  app.log.warn(
    'INTERNAL_API_TOKEN not set: internal, sync, event and scheduler routes are open (dev only)',
  );
}
if (!env.ADMIN_API_TOKEN && !env.IDENTITY_URL) {
  app.log.warn(
    'ADMIN_API_TOKEN / IDENTITY_URL not set: admin routes are unauthenticated (dev only)',
  );
}
app.log.info({ persistence: pool ? 'postgres' : 'memory' }, 'notifications starting');

const shutdown = async (): Promise<void> => {
  await app.close();
  await pool?.end();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: Number(env.PORT ?? 4006), host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
