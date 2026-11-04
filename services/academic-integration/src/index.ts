import { buildApp } from './app.js';
import {
  HttpAuditClient,
  HttpClassroomDirectory,
  HttpDeviceDirectory,
  HttpOrganizationClient,
} from './clients.js';
import { createPool } from './platform/pg.js';
import { InMemoryAcademicRepository } from './repository.js';
import { PgAcademicRepository } from './repository.pg.js';
import { parseSyncTargets, SyncService } from './sync.js';

const env = process.env;
const port = Number(env['PORT'] ?? 4003);
const organizationUrl = env['ORGANIZATION_SERVICE_URL'] ?? 'http://localhost:4002';
const auditUrl = env['AUDIT_SERVICE_URL'] ?? 'http://localhost:4011';
const internalToken = env['INTERNAL_API_TOKEN'];
const pool = env['DATABASE_URL'] ? createPool(env['DATABASE_URL']) : null;
const repository = pool ? new PgAcademicRepository(pool) : new InMemoryAcademicRepository();

const sync = new SyncService(
  parseSyncTargets(env['SYNC_TARGETS']),
  repository,
  new HttpClassroomDirectory(organizationUrl),
  {
    ...(internalToken ? { internalToken } : {}),
    retryIntervalMs: Number(env['SYNC_RETRY_INTERVAL_MS'] ?? 60_000),
    onError: (target, err) => app.log.warn({ target, err }, 'sync push failed'),
  },
);

const app = buildApp({
  repository,
  organization: new HttpOrganizationClient(organizationUrl),
  audit: new HttpAuditClient(auditUrl, (err) => app.log.warn({ err }, 'audit emission failed')),
  devices: new HttpDeviceDirectory(
    env['DEVICE_MANAGEMENT_URL'] ?? 'http://localhost:4004',
    env['DEVICE_MANAGEMENT_ADMIN_TOKEN'],
  ),
  sync,
  ...(internalToken ? { internalToken } : {}),
  logger: true,
});

app.log.info(
  { storage: pool ? 'postgres' : 'memory', syncTargets: sync.targets.map((t) => t.name) },
  'academic-integration configuration',
);
if (!internalToken)
  app.log.warn('INTERNAL_API_TOKEN is not set — internal routes are open (development only)');
app.addHook('onClose', async () => {
  await pool?.end();
});

app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
