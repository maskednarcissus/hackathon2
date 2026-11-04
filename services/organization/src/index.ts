import { buildApp } from './app.js';

const port = Number(process.env['PORT'] ?? 4002);
const host = process.env['HOST'] ?? '0.0.0.0';

const app = buildApp({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });

app.listen({ port, host }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
