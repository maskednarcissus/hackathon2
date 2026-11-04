import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import type { AlertContext } from './integration.js';
import { MapCalendarEventSource } from './student/directories.js';

const INST = '6f1c2e8a-1b2c-4d5e-8f90-1234567890ab';
const SECTION = '11111111-1111-4111-8111-111111111111';
const STUDENT = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const T0 = new Date('2026-11-04T12:00:00.000Z');
const min = (m: number): string => new Date(T0.getTime() + m * 60_000).toISOString();

interface Body {
  eventId: string;
  duplicate: boolean;
  raised: { id: string; rule: string }[];
  studentNotifications: { created: number; category: string } | null;
  items: Record<string, unknown>[];
  service: string;
  status: string;
  error: { code: string };
}

const envelope = (type: string, data: Record<string, unknown>, eventId = randomUUID()) => ({
  eventId,
  type,
  version: 1,
  occurredAt: T0.toISOString(),
  source: 'test',
  institutionId: INST,
  data,
});

const pubsub = (env: object) => ({
  message: {
    data: Buffer.from(JSON.stringify(env)).toString('base64'),
    messageId: '123',
    attributes: { type: 'x' },
  },
  subscription: 'projects/p/subscriptions/notifications-recording-uploaded',
});

describe('event bus delivery', () => {
  it('accepts the Pub/Sub push format and is idempotent by eventId', async () => {
    const { app } = buildApp({ clock: () => T0 });
    const env = envelope('upload.failed', {
      recordingSessionId: 'rs-1',
      reason: 'checksum_mismatch',
    });
    const first = await app.inject({
      method: 'POST',
      url: '/v1/lifecycle-events',
      payload: pubsub(env),
    });
    expect(first.statusCode).toBe(202);
    expect(first.json<Body>().raised).toHaveLength(1);
    const again = await app.inject({
      method: 'POST',
      url: '/v1/lifecycle-events',
      payload: pubsub(env),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<Body>()).toEqual({ eventId: env.eventId, duplicate: true });
    const alerts = await app.inject({ method: 'GET', url: '/v1/alerts' });
    expect(alerts.json<{ alerts: { occurrences: number }[] }>().alerts[0]!.occurrences).toBe(1);
    // raw envelopes still work
    const raw = await app.inject({
      method: 'POST',
      url: '/v1/lifecycle-events',
      payload: envelope('transcription.completed', { recordingSessionId: 'rs-1' }),
    });
    expect(raw.statusCode).toBe(202);
  });

  it('rejects undecodable push data', async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/lifecycle-events',
      payload: { message: { data: '!!!not-base64-json' }, subscription: 's' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('a failed fan-out is not marked processed, so the redelivery is retried', async () => {
    let fail = true;
    const calendar = new MapCalendarEventSource();
    const { app } = buildApp({
      calendar: {
        get: (id) => (fail ? Promise.reject(new Error('down')) : calendar.get(id)),
      },
    });
    const env = envelope('event.published', { calendarEventId: randomUUID() });
    expect(
      (await app.inject({ method: 'POST', url: '/v1/lifecycle-events', payload: env })).statusCode,
    ).toBe(503);
    fail = false;
    expect(
      (await app.inject({ method: 'POST', url: '/v1/lifecycle-events', payload: env })).statusCode,
    ).toBe(202);
  });

  it('requires x-internal-token on event, scheduler, sync and internal routes when configured', async () => {
    const { app } = buildApp({ internalToken: 'tok' });
    const env = envelope('transcription.completed', { recordingSessionId: 'rs' });
    const calls = [
      { method: 'POST' as const, url: '/v1/lifecycle-events', payload: env },
      { method: 'POST' as const, url: '/v1/alerts/evaluate', payload: {} },
      { method: 'POST' as const, url: '/v1/reminders/run', payload: {} },
      {
        method: 'POST' as const,
        url: '/v1/sync/enrollments',
        payload: { institutionId: INST, enrollments: [] },
      },
      {
        method: 'POST' as const,
        url: '/internal/v1/dsr/access',
        payload: { subjectType: 'user', subjectId: USER, requestId: 'r', institutionId: INST },
      },
    ];
    for (const c of calls) {
      expect((await app.inject(c)).statusCode).toBe(401);
      expect(
        (await app.inject({ ...c, headers: { 'x-internal-token': 'tok' } })).statusCode,
      ).toBeLessThan(300);
    }
  });
});

describe('alert context feed', () => {
  const context: AlertContext = {
    classWindows: [
      {
        scheduledClassId: 'class-A',
        classroomId: 'room-1',
        recordStartAt: min(0),
        recordStopAt: min(100),
      },
    ],
    devices: [{ deviceId: 'dev-1', classroomId: 'room-1', lastSeenAt: min(0), diskFreeBytes: 10 }],
  };

  it('pulls class windows and devices when the scheduler sends an empty body', async () => {
    const seen: Date[] = [];
    const { app } = buildApp({
      clock: () => new Date(min(10)),
      alertContext: {
        fetch: (now) => {
          seen.push(now);
          return Promise.resolve(context);
        },
      },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/alerts/evaluate', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(
      res
        .json<Body>()
        .raised.map((a) => a.rule)
        .sort(),
    ).toEqual(['device_offline', 'low_storage', 'recording_missed']);
    expect(seen[0]!.toISOString()).toBe(min(10));
    // an explicit body bypasses the feed
    await app.inject({ method: 'POST', url: '/v1/alerts/evaluate', payload: { classWindows: [] } });
    expect(seen).toHaveLength(1);
  });

  it('503 when the feed is unavailable', async () => {
    const { app } = buildApp({ alertContext: { fetch: () => Promise.reject(new Error('down')) } });
    const res = await app.inject({ method: 'POST', url: '/v1/alerts/evaluate', payload: {} });
    expect(res.statusCode).toBe(503);
  });
});

describe('calendar events with the full event inline', () => {
  it('uses data.event without calling the calendar and detects date changes', async () => {
    const calls: string[] = [];
    const { app } = buildApp({
      clock: () => T0,
      calendar: {
        get: (id) => {
          calls.push(id);
          return Promise.resolve(undefined);
        },
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/sync/enrollments',
      payload: {
        institutionId: INST,
        enrollments: [{ studentId: STUDENT, userId: USER, classSectionId: SECTION }],
      },
    });
    const event = {
      id: randomUUID(),
      institutionId: INST,
      courseId: randomUUID(),
      classSectionId: SECTION,
      extractedEventId: randomUUID(),
      type: 'examination',
      title: 'P2',
      description: null,
      eventDate: '2026-11-20',
      eventTime: null,
      timezone: 'America/Sao_Paulo',
      isOfficial: true,
      status: 'published',
      provenance: null,
      version: 1,
    };
    const pub = await app.inject({
      method: 'POST',
      url: '/v1/lifecycle-events',
      payload: envelope('calendar.event_published', { calendarEventId: event.id, event }),
    });
    expect(pub.json<Body>().studentNotifications).toMatchObject({
      category: 'new_assessment',
      created: 1,
    });
    const upd = await app.inject({
      method: 'POST',
      url: '/v1/lifecycle-events',
      payload: envelope('calendar.event_updated', {
        calendarEventId: event.id,
        changeType: 'date_change',
        event: { ...event, eventDate: '2026-11-27', version: 2 },
      }),
    });
    expect(upd.json<Body>().studentNotifications).toMatchObject({
      category: 'deadline_change',
      created: 1,
    });
    expect(calls).toEqual([]);
  });
});

describe('data subject rights (identity → notifications)', () => {
  async function seeded() {
    const calendar = new MapCalendarEventSource();
    const { app } = buildApp({ clock: () => T0, calendar });
    await app.inject({
      method: 'POST',
      url: '/v1/sync/enrollments',
      payload: {
        institutionId: INST,
        enrollments: [
          { studentId: STUDENT, userId: USER, classSectionId: SECTION, email: 'ana@aluno.example' },
        ],
      },
    });
    const id = randomUUID();
    calendar.events.set(id, {
      id,
      institutionId: INST,
      courseId: null,
      classSectionId: SECTION,
      extractedEventId: null,
      type: 'assignment',
      title: 'Trabalho 1',
      eventDate: '2026-11-20',
      eventTime: null,
      timezone: 'America/Sao_Paulo',
      status: 'published',
      version: 1,
    });
    await app.inject({
      method: 'POST',
      url: '/v1/lifecycle-events',
      payload: envelope('event.published', { calendarEventId: id }),
    });
    await app.inject({
      method: 'PUT',
      url: `/v1/users/${USER}/notification-preferences`,
      payload: { reminderOffsetsHours: [48] },
    });
    await app.inject({
      method: 'POST',
      url: `/v1/users/${USER}/push-subscriptions`,
      payload: {
        endpoint: 'https://push.example.com/x',
        keys: {
          p256dh: Buffer.alloc(65, 4).toString('base64url'),
          auth: Buffer.alloc(16, 1).toString('base64url'),
        },
      },
    });
    return app;
  }
  const dsr = (type: string, subjectType = 'student', subjectId = STUDENT) => ({
    method: 'POST' as const,
    url: `/internal/v1/dsr/${type}`,
    payload: { subjectType, subjectId, requestId: randomUUID(), institutionId: INST },
  });

  it('access exports inbox, preferences and push subscriptions (without keys), resolving student → user', async () => {
    const app = await seeded();
    const res = await app.inject(dsr('access'));
    const body = res.json<{
      service: string;
      status: string;
      items: { subjects: Record<string, unknown>[] };
    }>();
    expect(body).toMatchObject({ service: 'notifications', status: 'completed' });
    const [subject] = body.items.subjects;
    expect(subject).toMatchObject({ userId: USER });
    expect(subject!.notifications as unknown[]).toHaveLength(1);
    expect(subject!.preferences).toMatchObject({ reminderOffsetsHours: [48] });
    const subs = subject!.pushSubscriptions as Record<string, unknown>[];
    expect(subs).toHaveLength(1);
    expect(subs[0]).not.toHaveProperty('keys');
  });

  it('deletion removes inbox, preferences and subscriptions and erases the mirrored e-mail; idempotent', async () => {
    const app = await seeded();
    const del = await app.inject(dsr('deletion'));
    expect(del.json<{ items: { deleted: unknown[] } }>().items.deleted).toEqual([
      {
        userId: STUDENT,
        notifications: 0,
        preferences: 0,
        pushSubscriptions: 0,
        enrollmentsAnonymized: 0,
      },
      {
        userId: USER,
        notifications: 1,
        preferences: 1,
        pushSubscriptions: 1,
        enrollmentsAnonymized: 1,
      },
    ]);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/users/${USER}/notifications` })).json<Body>()
        .items,
    ).toEqual([]);
    const after = await app.inject(dsr('access', 'user', USER));
    expect(
      after.json<{ items: { subjects: { enrollments: { email: string | null }[] }[] } }>().items
        .subjects[0]!.enrollments[0]!.email,
    ).toBeNull();
    expect((await app.inject(dsr('deletion'))).statusCode).toBe(200);
  });

  it('correction and restriction are not applicable; bad payloads rejected', async () => {
    const app = await seeded();
    expect((await app.inject(dsr('correction'))).json<Body>().status).toBe('not_applicable');
    expect((await app.inject(dsr('restriction'))).json<Body>().status).toBe('not_applicable');
    expect((await app.inject(dsr('export'))).statusCode).toBe(400);
  });
});
