import { buildApp } from './app.js';
import {
  HttpAuditClient,
  HttpOrganizationClient,
  HttpScheduleClient,
  LoggingEventPublisher,
} from './clients.js';
import { loadDeviceCa } from './crypto.js';
import pino from 'pino';

const env = process.env;
const log = pino({ level: env['LOG_LEVEL'] ?? 'info' });

const ca = loadDeviceCa(env['DEVICE_CA_PRIVATE_KEY_PEM']);
if (ca.ephemeral) {
  if (env['NODE_ENV'] === 'production') {
    log.fatal('DEVICE_CA_PRIVATE_KEY_PEM is required in production');
    process.exit(1);
  }
  log.warn(
    'DEVICE_CA_PRIVATE_KEY_PEM not set: using an EPHEMERAL device CA key — certificates will not survive a restart',
  );
}
if (!env['ADMIN_API_TOKEN'])
  log.warn('ADMIN_API_TOKEN not set: admin routes are unauthenticated (development only)');

const { app, sweepStatuses } = buildApp({
  loggerInstance: log,
  ...(env['ADMIN_API_TOKEN'] ? { adminToken: env['ADMIN_API_TOKEN'] } : {}),
  deps: {
    ca,
    organization: new HttpOrganizationClient(env['ORGANIZATION_URL'] ?? 'http://localhost:4002'),
    schedule: new HttpScheduleClient(env['ACADEMIC_INTEGRATION_URL'] ?? 'http://localhost:4003'),
    audit: new HttpAuditClient(env['AUDIT_URL'] ?? 'http://localhost:4011', log),
    events: new LoggingEventPublisher(log),
  },
});

const sweepIntervalMs = Number(env['STATUS_SWEEP_INTERVAL_MS'] ?? 30_000);
const timer = setInterval(() => {
  sweepStatuses().catch((err: unknown) => log.error({ err }, 'status sweep failed'));
}, sweepIntervalMs);
timer.unref();

app
  .listen({ port: Number(env['PORT'] ?? 4004), host: env['HOST'] ?? '0.0.0.0' })
  .catch((err: unknown) => {
    log.error(err);
    process.exit(1);
  });
