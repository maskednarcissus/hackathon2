import pino from 'pino';
import { buildApp } from './app.js';
import {
  HttpAuditClient,
  HttpRetentionTarget,
  HttpRosterClient,
  type RetentionTarget,
} from './clients.js';
import type { RetentionKind } from './domain.js';
import { createInMemoryOrganizationRepository } from './repository.js';
import { createPgOrganizationRepository, createPool } from './repository.pg.js';

const env = process.env;
const log = pino({ level: env['LOG_LEVEL'] ?? 'info' });
const internalToken = env['INTERNAL_API_TOKEN'] || undefined;
if (!internalToken)
  log.warn('INTERNAL_API_TOKEN not set: scheduler/internal routes are open (development only)');

// Persistence (integration stage §1): DATABASE_URL → Postgres, otherwise in-memory.
const pool = env['DATABASE_URL'] ? createPool(env['DATABASE_URL']) : undefined;
if (!pool)
  log.warn('DATABASE_URL not set: using the in-memory repository (data is lost on restart)');
const repo = pool ? createPgOrganizationRepository(pool) : createInMemoryOrganizationRepository();

/**
 * Retention data owners (integration stage §5). Each implements
 * GET /internal/v1/retention/candidates and POST /internal/v1/retention/delete.
 * DSR fan-out is identity's job (Phase 4 §6); organization only owns consents and holds.
 */
const targetConfig: { name: string; envVar: string; fallback: string; kinds: RetentionKind[] }[] = [
  {
    name: 'audio-ingestion',
    envVar: 'AUDIO_INGESTION_URL',
    fallback: 'http://localhost:8001',
    kinds: ['audio'],
  },
  {
    name: 'transcript-management',
    envVar: 'TRANSCRIPT_MANAGEMENT_URL',
    fallback: 'http://localhost:4008',
    kinds: ['transcript'],
  },
  {
    name: 'lecture-intelligence',
    envVar: 'LECTURE_INTELLIGENCE_URL',
    fallback: 'http://localhost:8006',
    kinds: ['summary'],
  },
  {
    name: 'event-extraction',
    envVar: 'EVENT_EXTRACTION_URL',
    fallback: 'http://localhost:8007',
    kinds: ['extracted_event'],
  },
];
const disabled = new Set((env['RETENTION_TARGETS_DISABLED'] ?? '').split(',').filter(Boolean));
const retentionTargets: RetentionTarget[] = targetConfig
  .filter((t) => !disabled.has(t.name))
  .map(
    (t) =>
      new HttpRetentionTarget(t.name, env[t.envVar] ?? t.fallback, t.kinds, 30_000, internalToken),
  );

const app = buildApp({
  loggerInstance: log,
  ...(internalToken ? { internalToken } : {}),
  ...(env['ADMIN_API_TOKEN'] ? { adminToken: env['ADMIN_API_TOKEN'] } : {}),
  deps: {
    repo,
    audit: new HttpAuditClient(
      env['AUDIT_URL'] ?? 'http://localhost:4011',
      log,
      3000,
      internalToken,
    ),
    roster: new HttpRosterClient(
      env['ACADEMIC_INTEGRATION_URL'] ?? 'http://localhost:4003',
      5000,
      internalToken,
    ),
    retentionTargets,
  },
});

const shutdown = (): void => {
  app
    .close()
    .then(() => pool?.end())
    .catch((err: unknown) => log.error({ err }, 'shutdown failed'))
    .finally(() => process.exit(0));
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

app
  .listen({ port: Number(env['PORT'] ?? 4002), host: env['HOST'] ?? '0.0.0.0' })
  .catch((err: unknown) => {
    log.error(err);
    process.exit(1);
  });
