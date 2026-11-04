import pino from 'pino';
import { buildApp } from './app.js';
import {
  HttpAuditClient,
  HttpEventBusPublisher,
  HttpOrganizationClient,
  HttpScheduleClient,
  LoggingEventPublisher,
  PubSubRestPublisher,
  type EventPublisher,
} from './clients.js';
import { parseRoots } from './attestation.js';
import { loadDeviceCa } from './crypto.js';
import { loadReleaseSigner, parseTrustedKeys } from './firmware.js';
import { InMemoryDeviceRepository, type DeviceRepository } from './repository.js';
import { PgDeviceRepository, createPool } from './repository.pg.js';

const env = process.env;
const log = pino({ level: env['LOG_LEVEL'] ?? 'info' });
const internalToken = env['INTERNAL_API_TOKEN'] || undefined;

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
if (!internalToken)
  log.warn('INTERNAL_API_TOKEN not set: /internal/* routes are open (development only)');

// Persistence (integration stage §1): DATABASE_URL → Postgres, otherwise in-memory.
const pool = env['DATABASE_URL'] ? createPool(env['DATABASE_URL']) : undefined;
const repo: DeviceRepository = pool ? new PgDeviceRepository(pool) : new InMemoryDeviceRepository();
if (!pool)
  log.warn('DATABASE_URL not set: using the in-memory repository (data is lost on restart)');

// Event bus (§2): EVENT_BUS_URL → HTTP bus, PUBSUB_PROJECT_ID → Pub/Sub, else log only.
let events: EventPublisher;
if (env['EVENT_BUS_URL']) {
  events = new HttpEventBusPublisher(env['EVENT_BUS_URL'], { internalToken });
} else if (env['PUBSUB_PROJECT_ID']) {
  events = new PubSubRestPublisher(env['PUBSUB_PROJECT_ID'], {
    emulatorHost: env['PUBSUB_EMULATOR_HOST'],
  });
} else {
  events = new LoggingEventPublisher(log);
}

// Phase 6: vendor roots for hardware key attestation, trusted OTA release keys.
const attestationRoots = parseRoots(env['DEVICE_ATTESTATION_ROOTS']);
if (attestationRoots.length === 0)
  log.warn('DEVICE_ATTESTATION_ROOTS not set: models that require attestation cannot register');
const firmwareTrustedKeys = parseTrustedKeys(env['FIRMWARE_RELEASE_KEYS']);
const releaseSigner = loadReleaseSigner(
  env['FIRMWARE_SIGNING_PRIVATE_KEY_PEM'],
  env['FIRMWARE_SIGNING_KEY_ID'],
);
if (releaseSigner) {
  if (env['NODE_ENV'] === 'production') {
    log.fatal(
      'FIRMWARE_SIGNING_PRIVATE_KEY_PEM must not be set in production (sign releases offline)',
    );
    process.exit(1);
  }
  log.warn('server-side firmware manifest signing enabled (development only)');
}

const service = buildApp({
  attestationRoots,
  firmwareTrustedKeys,
  ...(releaseSigner ? { releaseSigner } : {}),
  loggerInstance: log,
  ...(env['ADMIN_API_TOKEN'] ? { adminToken: env['ADMIN_API_TOKEN'] } : {}),
  ...(internalToken ? { internalToken } : {}),
  deps: {
    ca,
    repo,
    organization: new HttpOrganizationClient(env['ORGANIZATION_URL'] ?? 'http://localhost:4002', {
      internalToken,
    }),
    schedule: new HttpScheduleClient(env['ACADEMIC_INTEGRATION_URL'] ?? 'http://localhost:4003', {
      internalToken,
    }),
    audit: new HttpAuditClient(env['AUDIT_URL'] ?? 'http://localhost:4011', log, { internalToken }),
    events,
  },
});

// In-process sweep; set STATUS_SWEEP_INTERVAL_MS=0 when Cloud Scheduler calls
// POST /internal/v1/status-sweep instead (integration stage §6).
const sweepIntervalMs = Number(env['STATUS_SWEEP_INTERVAL_MS'] ?? 30_000);
if (sweepIntervalMs > 0) {
  const timer = setInterval(() => {
    service.sweepStatuses().catch((err: unknown) => log.error({ err }, 'status sweep failed'));
  }, sweepIntervalMs);
  timer.unref();
}

const shutdown = (): void => {
  service.app
    .close()
    .then(() => pool?.end())
    .catch((err: unknown) => log.error({ err }, 'shutdown failed'))
    .finally(() => process.exit(0));
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

service.app
  .listen({ port: Number(env['PORT'] ?? 4004), host: env['HOST'] ?? '0.0.0.0' })
  .catch((err: unknown) => {
    log.error(err);
    process.exit(1);
  });
