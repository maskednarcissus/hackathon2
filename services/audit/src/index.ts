import { buildApp } from './app.js';
import { InMemoryContentReportRepository } from './content-reports.js';
import { publisherFromEnv } from './platform/event-bus.js';
import { createPool } from './platform/pg.js';
import { InMemoryAuditRepository } from './repository.js';
import { PgAuditRepository, PgContentReportRepository } from './repository.pg.js';

const env = process.env;
const port = Number(env['PORT'] ?? 4011);
const databaseUrl = env['DATABASE_URL'];
const pool = databaseUrl ? createPool(databaseUrl) : null;
const internalToken = env['INTERNAL_API_TOKEN'];

const app = buildApp({
  repository: pool ? new PgAuditRepository(pool) : new InMemoryAuditRepository(),
  contentReports: pool
    ? new PgContentReportRepository(pool)
    : new InMemoryContentReportRepository(),
  events: publisherFromEnv(env, (event) => app.log.info({ event }, 'event published')),
  ...(internalToken ? { internalToken } : {}),
  logger: true,
});

app.log.info({ storage: pool ? 'postgres' : 'memory' }, 'audit storage');
if (!internalToken)
  app.log.warn('INTERNAL_API_TOKEN is not set — internal routes are open (development only)');
app.addHook('onClose', async () => {
  await pool?.end();
});

app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
