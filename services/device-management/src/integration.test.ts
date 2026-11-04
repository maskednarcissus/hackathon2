import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { HttpEventBusPublisher, PubSubRestPublisher, type PlatformEvent } from './clients.js';
import { tokenMatches } from './internal-auth.js';
import { FakeOrganizationClient, FakeScheduleClient } from './test/helpers.js';

const event: PlatformEvent = {
  eventId: '0c6f1a43-7f43-4b5e-9a0c-2d7c1d0b8a11',
  type: 'device.heartbeat_missed',
  version: 1,
  occurredAt: '2026-11-04T12:00:00.000Z',
  source: 'device-management',
  institutionId: '11111111-1111-4111-8111-111111111111',
  data: { deviceId: 'd1' },
};

describe('internal token (§4)', () => {
  const { app } = buildApp({
    internalToken: 's3cret',
    deps: { organization: new FakeOrganizationClient(), schedule: new FakeScheduleClient() },
  });

  it('protects /internal/* and the status sweep', async () => {
    const sweep = await app.inject({ method: 'POST', url: '/internal/v1/status-sweep' });
    expect(sweep.statusCode).toBe(401);
    const wrong = await app.inject({
      method: 'POST',
      url: '/internal/v1/status-sweep',
      headers: { 'x-internal-token': 's3cret-but-longer' },
    });
    expect(wrong.statusCode).toBe(401);
    const ok = await app.inject({
      method: 'POST',
      url: '/internal/v1/status-sweep',
      headers: { 'x-internal-token': 's3cret' },
    });
    expect(ok.statusCode).toBe(200);
    const key = await app.inject({
      method: 'GET',
      url: '/internal/v1/devices/11111111-1111-4111-8111-111111111111/public-key',
    });
    expect(key.statusCode).toBe(401);
    // Public routes are unaffected.
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('compares in constant time and rejects missing tokens', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches(undefined, 'abc')).toBe(false);
  });
});

describe('event publishers (§2)', () => {
  let bus: FastifyInstance;
  let base: string;
  const received: { url: string; headers: Record<string, unknown>; body: unknown }[] = [];

  beforeAll(async () => {
    bus = Fastify();
    bus.post('/*', (req, reply) => {
      received.push({ url: req.url, headers: req.headers, body: req.body });
      return reply.status(req.url.includes('fail') ? 503 : 200).send({ ok: true });
    });
    base = await bus.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await bus.close();
  });

  it('POSTs the envelope to {EVENT_BUS_URL}/v1/topics/{type}:publish with the token', async () => {
    await new HttpEventBusPublisher(`${base}/`, { internalToken: 'tok' }).publish(event);
    const last = received.at(-1);
    expect(last?.url).toBe('/v1/topics/device.heartbeat_missed:publish');
    expect(last?.headers['x-internal-token']).toBe('tok');
    expect(last?.body).toEqual(event);
    await expect(
      new HttpEventBusPublisher(base).publish({ ...event, type: 'fail.me' }),
    ).rejects.toThrow(/503/);
  });

  it('publishes Pub/Sub messages (emulator) with base64 data and attributes', async () => {
    const host = base.replace('http://', '');
    await new PubSubRestPublisher('ci-dev', { emulatorHost: host }).publish(event);
    const last = received.at(-1);
    expect(last?.url).toBe('/v1/projects/ci-dev/topics/device.heartbeat_missed:publish');
    const body = last?.body as { messages: { data: string; attributes: Record<string, string> }[] };
    expect(JSON.parse(Buffer.from(body.messages[0]?.data ?? '', 'base64').toString())).toEqual(
      event,
    );
    expect(body.messages[0]?.attributes).toMatchObject({
      type: event.type,
      eventId: event.eventId,
    });
  });

  it('uses a bearer token from the metadata server outside the emulator', async () => {
    let calls = 0;
    const publisher = new PubSubRestPublisher('p', {
      fetchToken: (): Promise<{ access_token: string; expires_in: number }> => {
        calls += 1;
        return Promise.resolve({ access_token: 'ya29.x', expires_in: 3600 });
      },
    });
    // Point at the local bus by monkey-patching fetch only for this call.
    const realFetch = globalThis.fetch;
    let seenAuth: string | null = null;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      seenAuth = new Headers(init?.headers).get('authorization');
      return realFetch(String(url).replace('https://pubsub.googleapis.com', base), init);
    }) as typeof fetch;
    try {
      await publisher.publish(event);
      await publisher.publish(event);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seenAuth).toBe('Bearer ya29.x');
    expect(calls).toBe(1); // token cached
  });
});
