import { createPublicKey, randomUUID } from 'node:crypto';
import pg from 'pg';
import pino from 'pino';
import { HttpAuditClient, InMemoryAuditClient } from './audit-client.js';
import { buildApp, createDefaultDeps, DEFAULT_CONFIG } from './app.js';
import {
  FileSystemExportStore,
  HttpDataSubjectHandler,
  InMemoryDsrRepository,
  InMemoryExportStore,
  parseHandlerUrls,
} from './dsr.js';
import { KeyStore, loadSigningKey } from './keys.js';
import { hashPassword } from './password.js';
import {
  createInMemoryRepositories,
  InMemoryInstitutionDirectory,
  type InstitutionDirectory,
  type Repositories,
} from './repositories.js';
import {
  createPgRepositories,
  GraceCipher,
  PgDsrRepository,
  PgInstitutionDirectory,
} from './repository.pg.js';
import type { DsrRepository } from './dsr.js';
import { systemClock } from './tokens.js';

const logger = pino({ name: 'identity' });

async function main(): Promise<void> {
  const env = process.env;
  const { key, ephemeral } = loadSigningKey(env['IDENTITY_SIGNING_KEY_PEM']);
  if (ephemeral) {
    logger.warn(
      'IDENTITY_SIGNING_KEY_PEM is not set: using an ephemeral Ed25519 key. Tokens will not survive a restart. Never do this in production.',
    );
  }
  const previous = (env['IDENTITY_PREVIOUS_PUBLIC_KEYS_PEM'] ?? '')
    .split('-----END PUBLIC KEY-----')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => createPublicKey(`${chunk.replace(/\\n/g, '\n')}\n-----END PUBLIC KEY-----\n`));

  // Integration stage §1: DATABASE_URL → Postgres, otherwise in-memory (dev/tests).
  const databaseUrl = env['DATABASE_URL'];
  let repos: Repositories;
  let dsrRepo: DsrRepository;
  let institutions: InstitutionDirectory;
  if (databaseUrl) {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: Number(env['PG_POOL_MAX'] ?? 10),
    });
    const graceKey = env['IDENTITY_GRACE_KEY'];
    const graceCipher = graceKey
      ? new GraceCipher(Buffer.from(graceKey, 'base64'))
      : GraceCipher.fromSigningKey(key.privateKey);
    repos = createPgRepositories(pool, { graceCipher });
    dsrRepo = new PgDsrRepository(pool);
    institutions = new PgInstitutionDirectory(pool);
    logger.info('using PostgreSQL repositories');
  } else {
    repos = createInMemoryRepositories();
    dsrRepo = new InMemoryDsrRepository();
    // In-memory mode knows no holding companies: group executives can only be created with Postgres.
    institutions = new InMemoryInstitutionDirectory();
    logger.warn('DATABASE_URL is not set: using in-memory repositories (data is lost on restart)');
  }

  // Integration stage §4: one shared secret per environment; IDENTITY_INTERNAL_TOKEN kept as an alias.
  const internalToken = env['INTERNAL_API_TOKEN'] ?? env['IDENTITY_INTERNAL_TOKEN'];
  if (!internalToken) {
    logger.warn(
      'INTERNAL_API_TOKEN is not set: service-to-service calls must use an admin bearer token',
    );
  }
  const auditUrl = env['AUDIT_SERVICE_URL'];
  const deps = createDefaultDeps({
    repos,
    clock: systemClock,
    keyStore: new KeyStore(key, previous),
    audit: auditUrl ? new HttpAuditClient(auditUrl, logger) : new InMemoryAuditClient(),
    config: {
      ...DEFAULT_CONFIG,
      issuer: env['IDENTITY_ISSUER'] ?? DEFAULT_CONFIG.issuer,
      accessTokenTtlSeconds: env['IDENTITY_ACCESS_TOKEN_TTL_SECONDS']
        ? Number(env['IDENTITY_ACCESS_TOKEN_TTL_SECONDS'])
        : DEFAULT_CONFIG.accessTokenTtlSeconds,
      internalToken,
    },
    institutions,
    dsr: {
      repo: dsrRepo,
      handlers: parseHandlerUrls(env['DSR_HANDLER_URLS']).map(
        ({ name, url }) => new HttpDataSubjectHandler(name, url, { internalToken }),
      ),
      exportStore: env['DSR_EXPORT_DIR']
        ? new FileSystemExportStore(env['DSR_EXPORT_DIR'])
        : new InMemoryExportStore(),
    },
    logger,
  });

  // Optional bootstrap admin so a fresh environment can create further users.
  const bootstrapEmail = env['IDENTITY_BOOTSTRAP_ADMIN_EMAIL'];
  const bootstrapPassword = env['IDENTITY_BOOTSTRAP_ADMIN_PASSWORD'];
  const bootstrapInstitution = env['IDENTITY_BOOTSTRAP_INSTITUTION_ID'];
  const alreadyBootstrapped =
    bootstrapEmail && bootstrapInstitution
      ? await repos.users.findByEmail(bootstrapInstitution, bootstrapEmail)
      : undefined;
  if (bootstrapEmail && bootstrapPassword && bootstrapInstitution && !alreadyBootstrapped) {
    const now = new Date();
    const id = randomUUID();
    await repos.users.create({
      id,
      institutionId: bootstrapInstitution,
      email: bootstrapEmail.trim().toLowerCase(),
      name: 'Bootstrap administrator',
      role: 'admin',
      studentId: null,
      professorId: null,
      holdingCompanyId: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await repos.credentials.save({
      userId: id,
      passwordHash: await hashPassword(bootstrapPassword, deps.config.passwordParams),
      failedAttempts: 0,
      lockedUntil: null,
      passwordUpdatedAt: now,
    });
    logger.info({ userId: id }, 'bootstrap admin created');
  }

  const app = await buildApp(deps);
  await app.listen({ port: Number(env['PORT'] ?? 4001), host: '0.0.0.0' });
}

main().catch((err: unknown) => {
  logger.error({ err }, 'identity service failed to start');
  process.exit(1);
});
