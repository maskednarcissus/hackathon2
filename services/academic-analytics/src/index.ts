import { buildApp } from './app.js';
import {
  HttpAcademicClient,
  HttpAuditClient,
  HttpCalendarClient,
  HttpDeviceClient,
  HttpEventExtractionClient,
  HttpLectureClient,
  HttpNotificationsClient,
  HttpTranscriptClient,
} from './clients.js';
import { InMemoryDirectory } from './directory.js';
import { FakeEmbeddingClient, HttpEmbeddingClient } from './embeddings.js';
import { createJwksAccessTokenVerifier } from './jwt-verify.js';
import { InMemoryAnalyticsRepository } from './repository.js';

const env = process.env;
const url = (name: string, fallback: string): { baseUrl: string } => ({
  baseUrl: env[name] ?? fallback,
});
const authDisabled = env['AUTH_DISABLED'] === 'true';
const deviceToken = env['DEVICE_MANAGEMENT_ADMIN_TOKEN'];

const app = buildApp({
  repository: new InMemoryAnalyticsRepository(),
  directory: new InMemoryDirectory(),
  upstreams: {
    academic: new HttpAcademicClient(url('ACADEMIC_INTEGRATION_URL', 'http://localhost:4003')),
    calendar: new HttpCalendarClient(url('CALENDAR_URL', 'http://localhost:4005')),
    lectures: new HttpLectureClient(url('LECTURE_INTELLIGENCE_URL', 'http://localhost:8006')),
    audit: new HttpAuditClient(url('AUDIT_SERVICE_URL', 'http://localhost:4011')),
    transcripts: new HttpTranscriptClient(
      url('TRANSCRIPT_MANAGEMENT_URL', 'http://localhost:4008'),
    ),
    events: new HttpEventExtractionClient(url('EVENT_EXTRACTION_URL', 'http://localhost:8007')),
    devices: new HttpDeviceClient({
      ...url('DEVICE_MANAGEMENT_URL', 'http://localhost:4004'),
      ...(deviceToken ? { bearerToken: deviceToken } : {}),
    }),
    notifications: new HttpNotificationsClient(url('NOTIFICATIONS_URL', 'http://localhost:4006')),
  },
  embeddings:
    env['EMBEDDINGS_PROVIDER'] === 'gateway'
      ? new HttpEmbeddingClient(env['AI_GATEWAY_URL'] ?? 'http://localhost:8005')
      : new FakeEmbeddingClient(),
  auth: {
    disabled: authDisabled,
    ...(authDisabled
      ? {}
      : {
          verifier: createJwksAccessTokenVerifier({
            jwksUrl: env['IDENTITY_JWKS_URL'] ?? 'http://localhost:4001/.well-known/jwks.json',
          }),
        }),
    ...(env['INTERNAL_TOKEN'] ? { internalToken: env['INTERNAL_TOKEN'] } : {}),
  },
  logger: true,
});

if (authDisabled)
  app.log.warn('AUTH_DISABLED=true — analytics endpoints are unauthenticated (development only)');

app.listen({ port: Number(env['PORT'] ?? 4009), host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
