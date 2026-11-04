import { buildApp } from './app.js';
import { InMemoryContentReportRepository } from './content-reports.js';
import { LoggingEventPublisher } from './events.js';
import { InMemoryAuditRepository } from './repository.js';

const port = Number(process.env['PORT'] ?? 4011);
const app = buildApp({
  repository: new InMemoryAuditRepository(),
  contentReports: new InMemoryContentReportRepository(),
  events: new LoggingEventPublisher((event) => app.log.info({ event }, 'event published')),
  logger: true,
});

app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
