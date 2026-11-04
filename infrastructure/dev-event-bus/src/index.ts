import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildApp } from './app.js';
import { EventBus, type FetchLike } from './bus.js';
import { parseSubscriptions } from './subscriptions.js';

const env = process.env;
const file = resolve(env['SUBSCRIPTIONS_FILE'] ?? '../events/subscriptions.yaml');
const routes = parseSubscriptions(readFileSync(file, 'utf8'));
const internalToken = env['INTERNAL_API_TOKEN'];

const holder: { app?: ReturnType<typeof buildApp> } = {};
const bus = new EventBus({
  routes,
  env,
  fetch: fetch as unknown as FetchLike,
  internalToken,
  maxAttempts: Number(env['BUS_MAX_ATTEMPTS'] ?? 5),
  baseBackoffMs: Number(env['BUS_BACKOFF_MS'] ?? 200),
  timeoutMs: Number(env['BUS_TIMEOUT_MS'] ?? 120_000),
  log: (msg, data) => holder.app?.log.info(data, msg),
});

const app = buildApp({
  bus,
  internalToken,
  allowUnknownTopics: env['BUS_ALLOW_UNKNOWN_TOPICS'] === 'true',
  syncDelivery: env['BUS_SYNC_DELIVERY'] === 'true',
  logger: true,
});
holder.app = app;
if (!internalToken) app.log.warn('INTERNAL_API_TOKEN not set — event bus is open (dev only)');
for (const t of bus.topics()) {
  for (const s of t.subscriptions) {
    if (!s.endpoint) app.log.warn({ topic: t.topic, service: s.service }, 'no base URL for subscriber');
  }
}

const port = Number(env['PORT'] ?? 8090);
const shutdown = async (): Promise<void> => {
  await app.close();
  await bus.drain();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

app.listen({ port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
