import { buildApp } from './app.js';
import { HttpLectureClient } from './concepts/lectures.js';
import { InMemoryConceptRepository } from './concepts/model.js';
import { PgConceptRepository } from './concepts/repository.pg.js';
import { HttpAcademicClient, HttpAuditClient } from './clients.js';
import { createJwksAccessTokenVerifier } from './jwt-verify.js';
import { publisherFromEnv } from './platform/event-bus.js';
import { createPool } from './platform/pg.js';
import { InMemoryTranscriptRepository } from './repository.js';
import { PgTranscriptRepository } from './repository.pg.js';
import { FakeEmbeddingClient, HttpEmbeddingClient } from './search/embeddings.js';

const env = process.env;
const port = Number(env['PORT'] ?? 4008);
const pool = env['DATABASE_URL'] ? createPool(env['DATABASE_URL']) : null;
const pgRepo = pool ? new PgTranscriptRepository(pool) : null;
const internalToken = env['INTERNAL_API_TOKEN'];
// EMBEDDINGS_PROVIDER=gateway uses ai-gateway POST /v1/embed; default "fake" (deterministic, offline).
const embeddings =
  env['EMBEDDINGS_PROVIDER'] === 'gateway'
    ? new HttpEmbeddingClient(env['AI_GATEWAY_URL'] ?? 'http://localhost:8005')
    : new FakeEmbeddingClient();

const app = buildApp({
  repository: pgRepo ?? new InMemoryTranscriptRepository(),
  ...(pgRepo ? { vectorStore: pgRepo, warmSearchIndex: true } : {}),
  academic: new HttpAcademicClient(env['ACADEMIC_INTEGRATION_URL'] ?? 'http://localhost:4003'),
  audit: new HttpAuditClient(env['AUDIT_SERVICE_URL'] ?? 'http://localhost:4011', (err) =>
    app.log.warn({ err }, 'audit emission failed'),
  ),
  events: publisherFromEnv(env, (event) => app.log.info({ event }, 'event published')),
  embeddings,
  concepts: pool ? new PgConceptRepository(pool) : new InMemoryConceptRepository(),
  lectures: new HttpLectureClient(
    env['LECTURE_INTELLIGENCE_URL'] ?? 'http://localhost:8006',
    internalToken,
  ),
  ...(internalToken ? { internalToken } : {}),
  ...(env['IDENTITY_JWKS_URL']
    ? { verifier: createJwksAccessTokenVerifier({ jwksUrl: env['IDENTITY_JWKS_URL'] }) }
    : {}),
  logger: true,
});

app.log.info({ storage: pool ? 'postgres' : 'memory' }, 'transcript storage');
if (!internalToken)
  app.log.warn('INTERNAL_API_TOKEN is not set — internal routes are open (development only)');
app.addHook('onClose', async () => {
  await pool?.end();
});

app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
