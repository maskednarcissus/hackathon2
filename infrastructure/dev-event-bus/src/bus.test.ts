import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { EventBus, type FetchLike } from './bus.js';
import { parseSubscriptions, SubscriptionsParseError } from './subscriptions.js';

const YAML = `
topics:
  recording.uploaded:
    - name: audio-processing
      service: audio-processing
      path: /v1/events/recording-uploaded
    - name: notifications-alerts   # comment
      service: notifications
      path: /v1/lifecycle-events
  device.registered: []
`;

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { message: { data: string; messageId: string; attributes: Record<string, string> } };
}

function fakeFetch(statuses: Record<string, number[]>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Call['body'] });
    const queue = statuses[url] ?? [200];
    const status = queue.length > 1 ? (queue.shift() as number) : (queue[0] as number);
    if (status === 0) throw new Error('ECONNREFUSED');
    return { status, text: async () => (status >= 400 ? 'boom' : '') };
  };
  return { fetch, calls };
}

const ENV = {
  AUDIO_PROCESSING_URL: 'http://ap:8002/',
  NOTIFICATIONS_URL: 'http://no:4006',
};
const envelope = { eventId: '6a1b0d1e-0c5b-4b7e-9a51-8a0d7d1f4b11', type: 'recording.uploaded', data: { a: 1 } };

function setup(statuses: Record<string, number[]> = {}, internalToken?: string) {
  const { fetch, calls } = fakeFetch(statuses);
  const bus = new EventBus({
    routes: parseSubscriptions(YAML),
    env: ENV,
    fetch,
    internalToken,
    maxAttempts: 3,
    sleep: async () => undefined,
  });
  const app = buildApp({ bus, internalToken });
  return { app, bus, calls };
}

describe('subscriptions parser', () => {
  it('parses topics, subscriptions and empty lists', () => {
    const t = parseSubscriptions(YAML);
    expect([...t.keys()]).toEqual(['recording.uploaded', 'device.registered']);
    expect(t.get('recording.uploaded')?.map((s) => s.name)).toEqual([
      'audio-processing',
      'notifications-alerts',
    ]);
    expect(t.get('device.registered')).toEqual([]);
  });

  it('parses the real routing table', () => {
    const file = fileURLToPath(new URL('../../events/subscriptions.yaml', import.meta.url));
    const t = parseSubscriptions(readFileSync(file, 'utf8'));
    expect(t.get('recording.segmented')?.[0]?.path).toBe('/v1/events/recording-segmented');
    expect(t.get('diarization.completed')?.map((s) => s.service)).toEqual([
      'lecture-intelligence',
      'event-extraction',
    ]);
  });

  it('rejects malformed input with a line number', () => {
    expect(() => parseSubscriptions('topics:\n  Bad Topic:\n')).toThrow(SubscriptionsParseError);
    expect(() =>
      parseSubscriptions('topics:\n  a.b:\n    - name: x\n      service: y\n'),
    ).toThrow(/line 3/);
    expect(() =>
      parseSubscriptions(
        'topics:\n  a.b:\n    - name: x\n      service: y\n      path: /p\n    - name: x\n      service: y\n      path: /q\n',
      ),
    ).toThrow(/duplicate subscription/);
  });
});

describe('dev event bus', () => {
  it('fans out in Pub/Sub push format with the internal token', async () => {
    const { app, calls } = setup({}, 'secret');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/topics/recording.uploaded:publish?wait=true',
      headers: { 'x-internal-token': 'secret' },
      payload: envelope,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ deliveries: { status: string }[] }>();
    expect(body.deliveries.map((d) => d.status)).toEqual(['delivered', 'delivered']);
    expect(calls.map((c) => c.url).sort()).toEqual([
      'http://ap:8002/v1/events/recording-uploaded',
      'http://no:4006/v1/lifecycle-events',
    ]);
    const call = calls[0] as Call;
    expect(call.headers['x-internal-token']).toBe('secret');
    expect(JSON.parse(Buffer.from(call.body.message.data, 'base64').toString())).toEqual(envelope);
    expect(call.body.message.attributes['type']).toBe('recording.uploaded');
  });

  it('requires the internal token when configured', async () => {
    const { app } = setup({}, 'secret');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/topics/recording.uploaded:publish',
      payload: envelope,
    });
    expect(res.statusCode).toBe(401);
  });

  it('retries transient failures then succeeds', async () => {
    const { bus } = setup({ 'http://ap:8002/v1/events/recording-uploaded': [503, 0, 204] });
    const r = await bus.publish('recording.uploaded', envelope, true);
    const ap = r.deliveries?.find((d) => d.subscription === 'audio-processing');
    expect(ap?.status).toBe('delivered');
    expect(ap?.attempts).toBe(3);
    expect(bus.listDeadLetters()).toHaveLength(0);
  });

  it('dead-letters after max attempts and on permanent 4xx, and can replay', async () => {
    const { app, bus, calls } = setup({
      'http://ap:8002/v1/events/recording-uploaded': [500, 500, 500, 200],
      'http://no:4006/v1/lifecycle-events': [422, 200],
    });
    await bus.publish('recording.uploaded', envelope, true);
    const dl = bus.listDeadLetters();
    expect(dl.map((d) => [d.subscription, d.attempts]).sort()).toEqual([
      ['audio-processing', 3],
      ['notifications-alerts', 1],
    ]);
    const list = await app.inject({ method: 'GET', url: '/v1/dead-letters' });
    expect(list.json<{ total: number }>().total).toBe(2);

    const target = dl.find((d) => d.subscription === 'audio-processing');
    const replay = await app.inject({
      method: 'POST',
      url: `/v1/dead-letters/${target?.deliveryId}/replay`,
    });
    expect(replay.json<{ status: string }>().status).toBe('delivered');
    expect(bus.listDeadLetters()).toHaveLength(1);
    expect(calls.length).toBe(5);
  });

  it('dead-letters subscriptions whose service URL is not configured', async () => {
    const { fetch } = fakeFetch({});
    const bus = new EventBus({ routes: parseSubscriptions(YAML), env: {}, fetch });
    const r = await bus.publish('recording.uploaded', envelope, true);
    expect(r.deliveries?.every((d) => d.status === 'skipped')).toBe(true);
    expect(bus.listDeadLetters()[0]?.lastError).toMatch(/AUDIO_PROCESSING|no base URL/);
  });

  it('validates topic and envelope', async () => {
    const { app } = setup();
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/topics/nope.topic:publish',
      payload: { ...envelope, type: 'nope.topic' },
    });
    expect(unknown.statusCode).toBe(404);
    const mismatch = await app.inject({
      method: 'POST',
      url: '/v1/topics/device.registered:publish',
      payload: envelope,
    });
    expect(mismatch.statusCode).toBe(400);
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/topics/recording.uploaded:publish',
      payload: { type: 'recording.uploaded' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('answers 202 asynchronously by default and drains', async () => {
    const { app, bus, calls } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/topics/recording.uploaded:publish',
      payload: envelope,
    });
    expect(res.statusCode).toBe(202);
    await bus.drain();
    expect(calls).toHaveLength(2);
    expect(bus.recentDeliveries()).toHaveLength(2);
  });
});
