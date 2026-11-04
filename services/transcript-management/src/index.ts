import { buildApp } from './app.js';
import { HttpAcademicClient, HttpAuditClient } from './clients.js';
import { LoggingEventPublisher } from './events.js';
import { InMemoryTranscriptRepository } from './repository.js';
import { FakeEmbeddingClient, HttpEmbeddingClient } from './search/embeddings.js';

const env = process.env;
const port = Number(env['PORT'] ?? 4008);
// EMBEDDINGS_PROVIDER=gateway uses ai-gateway POST /v1/embed; default "fake" (deterministic, offline).
const embeddings =
  env['EMBEDDINGS_PROVIDER'] === 'gateway'
    ? new HttpEmbeddingClient(env['AI_GATEWAY_URL'] ?? 'http://localhost:8005')
    : new FakeEmbeddingClient();

const app = buildApp({
  repository: new InMemoryTranscriptRepository(),
  academic: new HttpAcademicClient(env['ACADEMIC_INTEGRATION_URL'] ?? 'http://localhost:4003'),
  audit: new HttpAuditClient(env['AUDIT_SERVICE_URL'] ?? 'http://localhost:4011', (err) =>
    app.log.warn({ err }, 'audit emission failed'),
  ),
  events: new LoggingEventPublisher((event) => app.log.info({ event }, 'event published')),
  embeddings,
  logger: true,
});

app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
