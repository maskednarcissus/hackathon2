import pino from 'pino';
import { buildApp } from './app.js';
import {
  HttpAuditClient,
  HttpRetentionTarget,
  HttpRosterClient,
  type RetentionTarget,
} from './clients.js';
import type { RetentionKind } from './domain.js';

const env = process.env;
const log = pino({ level: env['LOG_LEVEL'] ?? 'info' });

/** Data owners asked for retention candidates, per phase-4 contract §5. */
const targetConfig: { name: string; envVar: string; fallback: string; kinds: RetentionKind[] }[] = [
  {
    name: 'audio-ingestion',
    envVar: 'AUDIO_INGESTION_URL',
    fallback: 'http://localhost:8001',
    kinds: ['audio'],
  },
  {
    name: 'transcript-management',
    envVar: 'TRANSCRIPT_MANAGEMENT_URL',
    fallback: 'http://localhost:4008',
    kinds: ['transcript'],
  },
  {
    name: 'lecture-intelligence',
    envVar: 'LECTURE_INTELLIGENCE_URL',
    fallback: 'http://localhost:8006',
    kinds: ['summary'],
  },
  {
    name: 'event-extraction',
    envVar: 'EVENT_EXTRACTION_URL',
    fallback: 'http://localhost:8007',
    kinds: ['extracted_event'],
  },
];
const retentionTargets: RetentionTarget[] = targetConfig.map(
  (t) => new HttpRetentionTarget(t.name, env[t.envVar] ?? t.fallback, t.kinds),
);

const app = buildApp({
  loggerInstance: log,
  deps: {
    audit: new HttpAuditClient(env['AUDIT_URL'] ?? 'http://localhost:4011', log),
    roster: new HttpRosterClient(env['ACADEMIC_INTEGRATION_URL'] ?? 'http://localhost:4003'),
    retentionTargets,
  },
});

app
  .listen({ port: Number(env['PORT'] ?? 4002), host: env['HOST'] ?? '0.0.0.0' })
  .catch((err: unknown) => {
    log.error(err);
    process.exit(1);
  });
