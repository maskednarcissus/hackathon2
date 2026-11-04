import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { HttpAuditClient } from './audit.js';
import { InMemoryCalendarRepository } from './repository.js';

const port = Number(process.env['PORT'] ?? 4005);
const auditUrl = process.env['AUDIT_URL'] ?? 'http://localhost:4011';

const start = async (): Promise<void> => {
  const ref: { app?: FastifyInstance } = {};
  const audit = new HttpAuditClient(auditUrl, {
    warn: (obj: unknown, msg?: string): void => ref.app?.log.warn(obj, msg),
  });
  // Phase 2 ships with the in-memory repository; the PostgreSQL adapter targets the V002 tables.
  const app = buildApp({
    repository: new InMemoryCalendarRepository(),
    audit,
    logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
  });
  ref.app = app;
  try {
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
