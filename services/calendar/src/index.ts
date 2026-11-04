import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp } from './app.js';
import { HttpAuditClient } from './audit.js';
import { HttpEventBusPublisher, InMemoryEventPublisher, type EventPublisher } from './events.js';
import { InMemoryFeedTokenRepository, type FeedTokenRepository } from './feed-tokens.js';
import { createJwksAccessTokenVerifier, type AccessTokenVerifier } from './jwt-verify.js';
import { InMemoryCalendarRepository, type CalendarRepository } from './repository.js';
import { PgCalendarRepository, PgFeedTokenRepository } from './repository.pg.js';
import { TokenCipher } from './external/crypto.js';
import {
  GoogleCalendarProvider,
  MicrosoftCalendarProvider,
  type CalendarProvider,
  type ProviderId,
} from './external/providers.js';
import {
  InMemoryExternalCalendarRepository,
  type ExternalCalendarRepository,
} from './external/repository.js';
import { PgExternalCalendarRepository } from './external/repository.pg.js';

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
  let externalRepo: ExternalCalendarRepository;
  if (env['DATABASE_URL']) {
    const pool = new pg.Pool({
      connectionString: env['DATABASE_URL'],
      max: Number(env['PG_POOL_MAX'] ?? 10),
    });
    repository = new PgCalendarRepository(pool);
    feedTokens = new PgFeedTokenRepository(pool);
    externalRepo = new PgExternalCalendarRepository(pool);
  } else {
    repository = new InMemoryCalendarRepository();
    feedTokens = new InMemoryFeedTokenRepository();
    externalRepo = new InMemoryExternalCalendarRepository();
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

  // Phase 6 §6.9: external calendars. Secrets come from Secret Manager via the environment.
  const secret = (name: string): string | undefined => {
    const ref = env[`${name}_REF`];
    return ref?.startsWith('env:') ? env[ref.slice(4)] : env[name];
  };
  const providers: Partial<Record<ProviderId, CalendarProvider>> = {};
  const googleId = env['GOOGLE_CALENDAR_CLIENT_ID'];
  const googleSecret = secret('GOOGLE_CALENDAR_CLIENT_SECRET');
  if (googleId && googleSecret) {
    providers.google = new GoogleCalendarProvider({
      clientId: googleId,
      clientSecret: googleSecret,
    });
  }
  const msId = env['MICROSOFT_CALENDAR_CLIENT_ID'];
  const msSecret = secret('MICROSOFT_CALENDAR_CLIENT_SECRET');
  if (msId && msSecret) {
    providers.microsoft = new MicrosoftCalendarProvider({
      clientId: msId,
      clientSecret: msSecret,
      tenant: env['MICROSOFT_CALENDAR_TENANT'] ?? 'common',
    });
  }
  let cipher = TokenCipher.fromEnv(env);
  if (!cipher) {
    if (env['NODE_ENV'] === 'production' && Object.keys(providers).length > 0) {
      throw new Error('CALENDAR_TOKEN_KEY (or CALENDAR_TOKEN_KEY_REF) is required in production');
    }
    cipher = TokenCipher.ephemeral();
    if (Object.keys(providers).length > 0) {
      warnings.push(
        'CALENDAR_TOKEN_KEY is not set: external calendar tokens will not survive a restart',
      );
    }
  }

  const app = buildApp({
    repository,
    feedTokens,
    audit: new HttpAuditClient(auditUrl, log),
    events,
    external: {
      repo: externalRepo,
      providers,
      cipher,
      redirectBaseUrl: env['CALENDAR_OAUTH_REDIRECT_BASE_URL'] ?? `http://localhost:${port}`,
    },
    ...(env['CALENDAR_CONNECT_RETURN_URL']
      ? { externalReturnUrl: env['CALENDAR_CONNECT_RETURN_URL'] }
      : {}),
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
