import { buildApp } from './app.js';
import { InMemoryTranscriptRepository } from './repository.js';

const port = Number(process.env['PORT'] ?? 4008);
const app = buildApp({ repository: new InMemoryTranscriptRepository(), logger: true });

app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
