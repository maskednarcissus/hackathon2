import { buildApp } from './app.js';
import { HttpAuditClient, HttpOrganizationClient } from './clients.js';
import { InMemoryAcademicRepository } from './repository.js';

const port = Number(process.env['PORT'] ?? 4003);
const organizationUrl = process.env['ORGANIZATION_SERVICE_URL'] ?? 'http://localhost:4002';
const auditUrl = process.env['AUDIT_SERVICE_URL'] ?? 'http://localhost:4011';

const app = buildApp({
  repository: new InMemoryAcademicRepository(),
  organization: new HttpOrganizationClient(organizationUrl),
  audit: new HttpAuditClient(auditUrl, (err) => app.log.warn({ err }, 'audit emission failed')),
  logger: true,
});

app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
