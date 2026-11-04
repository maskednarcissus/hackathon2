import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp } from './app.js';
import { HttpAuditClient } from './audit.js';
import { HttpEventBusPublisher, InMemoryEventPublisher, type EventPublisher } from './events.js';
import { InMemoryFeedTokenRepository, type FeedTokenRepository } from './feed-tokens.js';
import { createJwksAccessTokenVerifier, type AccessTokenVerifier } from './jwt-verify.js';
import { InMemoryCalendarRepository, type CalendarRepository } from './repository.js';
import { PgCalendarRepository, PgFeedTokenRepository } from './repository.pg.js';

const env = process.env;
const port = Number(env['PORT'] ?? 4005);
const auditUrl = env['AUDIT_URL'] ?? env['AUDIT_SERVICE_URL'] ?? 'http://localhost:4011';

const start = async (): Promise<void> => {
  const ref: { app?: FastifyInstance } = {};
  const log = {
    warn: (obj: unknown, msg?: string): void => ref.app?.log.warn(obj, msg),
  };
  const warnings: string[] = [];

  // §1: DATABASE_URL → Postgres, otherwise in-memory.
  let repository: CalendarRepository;
  let feedTokens: FeedTokenRepository;
  if (env['DATABASE_URL']) {
    const pool = new pg.Pool({
      connectionString: env['DATABASE_URL'],
      max: Number(env['PG_POOL_MAX'] ?? 10),
    });
    repository = new PgCalendarRepository(pool);
    feedTokens = new PgFeedTokenRepository(pool);
  } else {
    repository = new InMemoryCalendarRepository();
    feedTokens = new InMemoryFeedTokenRepository();
    warnings.push('DATABASE_URL is not set: using in-memory repositories');
  }

  // §4: shared service-to-service secret.
  const internalToken = env['INTERNAL_API_TOKEN'];
  if (!internalToken)
    warnings.push('INTERNAL_API_TOKEN is not set: internal endpoints are open (dev only)');

  // §2: event bus.
  const events: EventPublisher = env['EVENT_BUS_URL']
    ? new HttpEventBusPublisher(env['EVENT_BUS_URL'], log, { internalToken })
    : new InMemoryEventPublisher();
  if (!env['EVENT_BUS_URL'])
    warnings.push('EVENT_BUS_URL is not set: calendar events are not delivered');

  // §4: identity JWTs on student routes.
  let verifyAccessToken: AccessTokenVerifier | undefined;
  const jwksUrl =
    env['IDENTITY_JWKS_URL'] ??
    (env['IDENTITY_URL']
      ? `${env['IDENTITY_URL'].replace(/\/$/, '')}/.well-known/jwks.json`
      : undefined);
  if (jwksUrl) {
    verifyAccessToken = createJwksAccessTokenVerifier({ jwksUrl, leewaySeconds: 30 });
  } else if (env['NODE_ENV'] === 'production') {
    throw new Error('IDENTITY_JWKS_URL (or IDENTITY_URL) is required in production');
  } else {
    warnings.push('IDENTITY_JWKS_URL is not set: student routes are not authenticated (dev only)');
  }

  const app = buildApp({
    repository,
    feedTokens,
    audit: new HttpAuditClient(auditUrl, log),
    events,
    ...(internalToken ? { internalToken } : {}),
    ...(verifyAccessToken ? { verifyAccessToken } : {}),
    logger: { level: env['LOG_LEVEL'] ?? 'info' },
  });
  ref.app = app;
  for (const w of warnings) app.log.warn(w);
  try {
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
