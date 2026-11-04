import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as edSign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import {
  MapCalendarEventSource,
  MapClassDirectory,
  type CalendarEventDetails,
} from './student/directories.js';
import { InMemoryEmailSender } from './student/email.js';
import { quietUntil } from './student/preferences.js';
import {
  b64url,
  buildVapidJwt,
  encryptPayload,
  FakePushSender,
  fromB64url,
  generateVapidKeys,
  WebPushSender,
} from './student/webpush.js';
import { createAccessTokenVerifier } from './vendor/jwt-verify.js';

/** Response bodies used in assertions (typed for lint; fields are a superset). */
interface Body {
  error: { code: string };
  studentNotifications: { created: number; recipients: number; duplicates: number };
  items: Record<string, unknown>[];
  categories: Record<string, unknown>;
  reminderOffsetsHours: number[];
  id: string;
  created: number;
}

const INST = '6f1c2e8a-1b2c-4d5e-8f90-1234567890ab';
const SECTION = '11111111-1111-4111-8111-111111111111';
const OTHER_SECTION = '22222222-2222-4222-8222-222222222222';
const students = ['a', 'b', 'c'].map((s, i) => ({
  studentId: `0000000${i}-0000-4000-8000-00000000000${i}`,
  userId: `user-${s}`,
  email: `${s}@aluno.example`,
}));

function setup(start = '2026-11-04T15:00:00.000Z') {
  let now = new Date(start);
  const calendar = new MapCalendarEventSource();
  const classes = new MapClassDirectory();
  const email = new InMemoryEmailSender();
  const push = new FakePushSender();
  const { app } = buildApp({
    calendar,
    classes,
    email,
    push,
    clock: () => now,
    vapidPublicKey: 'BPUB',
  });
  const inject = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const event = (type: string, data: Record<string, unknown>) =>
    inject('POST', '/v1/lifecycle-events', {
      eventId: randomUUID(),
      type,
      version: 1,
      occurredAt: now.toISOString(),
      source: 'test',
      institutionId: INST,
      data,
    });
  const calEvent = (patch: Partial<CalendarEventDetails> = {}): CalendarEventDetails => {
    const e: CalendarEventDetails = {
      id: randomUUID(),
      institutionId: INST,
      courseId: null,
      classSectionId: SECTION,
      extractedEventId: randomUUID(),
      type: 'examination',
      title: 'P1 — Macroeconomia',
      eventDate: '2026-11-10',
      eventTime: '19:00',
      timezone: 'America/Sao_Paulo',
      status: 'published',
      version: 1,
      ...patch,
    };
    calendar.events.set(e.id, e);
    return e;
  };
  const sync = (
    rows: Record<string, unknown>[] = students.map((s) => ({
      ...s,
      classSectionId: SECTION,
      status: 'active',
    })),
  ) => inject('POST', '/v1/sync/enrollments', { institutionId: INST, enrollments: rows });
  const inbox = async (userId: string, qs = '') =>
    (await inject('GET', `/v1/users/${userId}/notifications${qs}`)).json<{
      items: { id: string; category: string; title: string; body: string; readAt: string | null }[];
      unreadCount: number;
    }>();
  return {
    app,
    calendar,
    classes,
    email,
    push,
    inject,
    event,
    calEvent,
    sync,
    inbox,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
  };
}

const validSub = () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  return {
    ua,
    auth: randomBytes(16),
    body: (endpoint = 'https://push.example.com/send/abc') => ({
      endpoint,
      keys: { p256dh: b64url(ua.getPublicKey()), auth: '' },
    }),
  };
};

describe('student notifications — fan-out', () => {
  it('event.published notifies only active students of the section (in_app + email + push)', async () => {
    const t = setup();
    await t.sync([
      ...students.map((s) => ({ ...s, classSectionId: SECTION, status: 'active' })),
      {
        studentId: randomUUID(),
        userId: 'user-withdrawn',
        classSectionId: SECTION,
        status: 'withdrawn',
      },
      {
        studentId: randomUUID(),
        userId: 'user-other',
        classSectionId: OTHER_SECTION,
        status: 'active',
      },
    ]);
    const s = validSub();
    const sub = s.body();
    sub.keys.auth = b64url(s.auth);
    expect((await t.inject('POST', '/v1/users/user-a/push-subscriptions', sub)).statusCode).toBe(
      201,
    );

    const cal = t.calEvent();
    const res = await t.event('event.published', {
      eventId: cal.extractedEventId,
      calendarEventId: cal.id,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json<Body>().studentNotifications).toMatchObject({
      category: 'new_assessment',
      created: 3,
      recipients: 3,
    });

    const a = await t.inbox('user-a');
    expect(a.unreadCount).toBe(1);
    expect(a.items[0]).toMatchObject({
      category: 'new_assessment',
      title: 'Nova avaliação/prazo: Prova',
    });
    expect(a.items[0]!.body).toContain('10/11/2026 às 19:00');
    expect((await t.inbox('user-withdrawn')).items).toHaveLength(0);
    expect((await t.inbox('user-other')).items).toHaveLength(0);
    expect(t.email.sent.map((m) => m.to).sort()).toEqual([
      'a@aluno.example',
      'b@aluno.example',
      'c@aluno.example',
    ]);
    expect(t.push.sent).toHaveLength(1);
    expect(t.push.sent[0]!.message.title).toBe('Nova avaliação/prazo: Prova');
  });

  it('dedupes redelivered events by (userId, category, resourceId, version)', async () => {
    const t = setup();
    await t.sync();
    const cal = t.calEvent();
    await t.event('event.published', { calendarEventId: cal.id });
    const again = await t.event('event.published', { calendarEventId: cal.id });
    expect(again.json<Body>().studentNotifications).toMatchObject({ created: 0, duplicates: 3 });
    expect((await t.inbox('user-b')).items).toHaveLength(1);
    expect(t.email.sent).toHaveLength(3);
  });

  it('event.updated with date change → "Prazo alterado"; other edits are silent', async () => {
    const t = setup();
    await t.sync();
    const cal = t.calEvent();
    await t.event('event.published', { eventId: cal.extractedEventId, calendarEventId: cal.id });

    t.calendar.events.set(cal.id, { ...cal, title: 'P1 (sala 3)', version: 2 });
    const silent = await t.event('event.updated', {
      eventId: cal.extractedEventId,
      fields: ['title'],
    });
    expect(silent.json<Body>().studentNotifications).toMatchObject({
      created: 0,
      skippedReason: 'no_date_change',
    });

    // resolved via extractedEventId → tracked calendarEventId
    t.setNow('2026-11-04T16:00:00.000Z');
    t.calendar.events.set(cal.id, {
      ...cal,
      title: 'P1 (sala 3)',
      eventDate: '2026-11-17',
      version: 3,
    });
    const changed = await t.event('event.updated', {
      eventId: cal.extractedEventId,
      field: 'eventDate',
    });
    expect(changed.json<Body>().studentNotifications).toMatchObject({
      category: 'deadline_change',
      created: 3,
    });
    const [latest] = (await t.inbox('user-a')).items;
    expect(latest).toMatchObject({ category: 'deadline_change', title: 'Prazo alterado: Prova' });
    expect(latest!.body).toBe('P1 (sala 3): de 10/11/2026 às 19:00 para 17/11/2026 às 19:00.');
  });

  it('cancellations notify once with the critical category', async () => {
    const t = setup();
    await t.sync();
    const cal = t.calEvent({ type: 'class_cancellation', title: 'Aula de 06/11' });
    const pub = await t.event('event.published', { calendarEventId: cal.id });
    expect(pub.json<Body>().studentNotifications).toMatchObject({
      category: 'class_cancellation',
      created: 3,
    });
    expect((await t.inbox('user-a')).items[0]!.title).toBe('Aula cancelada');

    const exam = t.calEvent();
    await t.event('event.published', { calendarEventId: exam.id });
    t.calendar.events.set(exam.id, { ...exam, status: 'cancelled', version: 2 });
    const r = await t.event('calendar.event_updated', { calendarEventId: exam.id });
    expect(r.json<Body>().studentNotifications).toMatchObject({
      category: 'class_cancellation',
      created: 3,
    });
    const again = await t.event('calendar.event_updated', { calendarEventId: exam.id });
    expect(again.json<Body>().studentNotifications.created).toBe(0);
  });

  it('lecture.structured resolves the section via academic-integration', async () => {
    const t = setup();
    await t.sync();
    const scheduledClassId = randomUUID();
    t.classes.classes.set(scheduledClassId, {
      id: scheduledClassId,
      classSectionId: SECTION,
      localDate: '2026-11-03',
    });
    const r = await t.event('lecture.structured', {
      scheduledClassId,
      transcriptId: randomUUID(),
      lectureSummaryId: randomUUID(),
    });
    expect(r.json<Body>().studentNotifications).toMatchObject({
      category: 'lecture_summary',
      created: 3,
    });
    expect((await t.inbox('user-c')).items[0]).toMatchObject({
      title: 'Resumo da aula disponível',
      body: 'O resumo da aula de 03/11/2026 já pode ser consultado.',
    });
    // lecture_summary has email off by default
    expect(t.email.sent).toHaveLength(0);
  });

  it('returns 503 (retryable) when the calendar cannot be reached', async () => {
    const { app } = buildApp({
      calendar: { get: () => Promise.reject(new Error('ECONNREFUSED')) },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/lifecycle-events',
      payload: {
        eventId: randomUUID(),
        type: 'event.published',
        version: 1,
        occurredAt: new Date().toISOString(),
        source: 't',
        data: { calendarEventId: randomUUID() },
      },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<Body>().error.code).toBe('dependency_unavailable');
  });

  it('inbox items match the student-web AppNotification shape with deep links', async () => {
    const t = setup();
    await t.sync();
    const cal = t.calEvent();
    await t.event('event.published', { calendarEventId: cal.id });
    t.setNow('2026-11-04T16:00:00.000Z');
    const scheduledClassId = randomUUID();
    await t.event('lecture.structured', {
      scheduledClassId,
      classSectionId: SECTION,
      lectureSummaryId: randomUUID(),
    });
    const res = await t.inject('GET', '/v1/users/user-a/notifications');
    const [lecture, exam] = res.json<Body>().items;
    expect(Object.keys(exam!).sort()).toEqual([
      'body',
      'category',
      'createdAt',
      'id',
      'link',
      'readAt',
      'title',
    ]);
    expect(exam).toMatchObject({
      category: 'new_assessment',
      readAt: null,
      link: `/calendario/${cal.id}`,
    });
    expect(lecture).toMatchObject({
      category: 'lecture_summary',
      link: `/aulas/${scheduledClassId}`,
    });
    // a PUT echoing the GET body (userId, updatedAt) is accepted
    const prefs = (await t.inject('GET', '/v1/users/user-a/notification-preferences')).json<Body>();
    expect(
      (await t.inject('PUT', '/v1/users/user-a/notification-preferences', prefs)).statusCode,
    ).toBe(200);
  });

  it('inbox: unread filter, read, read-all', async () => {
    const t = setup();
    await t.sync();
    await t.event('event.published', { calendarEventId: t.calEvent().id });
    await t.event('event.published', {
      calendarEventId: t.calEvent({ title: 'Trabalho 2', type: 'assignment' }).id,
    });
    const inbox = await t.inbox('user-a', '?unread=true');
    expect(inbox.items).toHaveLength(2);
    const read = await t.inject(
      'POST',
      `/v1/users/user-a/notifications/${inbox.items[0]!.id}/read`,
    );
    expect(read.json<Body>()).toMatchObject({ unreadCount: 1 });
    expect((await t.inbox('user-a', '?unread=false')).items).toHaveLength(1);
    // another user cannot mark it
    expect(
      (await t.inject('POST', `/v1/users/user-b/notifications/${inbox.items[0]!.id}/read`))
        .statusCode,
    ).toBe(404);
    expect(
      (await t.inject('POST', '/v1/users/user-a/notifications/read-all')).json<Body>(),
    ).toMatchObject({ updated: 1 });
    expect((await t.inbox('user-a')).unreadCount).toBe(0);
  });

  it('sync replace mode withdraws students missing from the payload', async () => {
    const t = setup();
    await t.sync();
    const r = await t.inject('POST', '/v1/sync/enrollments', {
      institutionId: INST,
      mode: 'replace',
      enrollments: [{ ...students[0]!, classSectionId: SECTION }],
    });
    expect(r.json<Body>()).toEqual({ upserted: 1, withdrawn: 2 });
    const pub = await t.event('event.published', { calendarEventId: t.calEvent().id });
    expect(pub.json<Body>().studentNotifications.recipients).toBe(1);
  });
});

describe('student notifications — preferences (3.12)', () => {
  it('returns defaults and merges partial updates', async () => {
    const t = setup();
    const def = (await t.inject('GET', '/v1/users/user-a/notification-preferences')).json<Body>();
    expect(def).toMatchObject({ reminderOffsetsHours: [24, 2], quietHours: null });
    expect(def.categories.deadline_change).toEqual({ in_app: true, email: true, push: true });
    const put = await t.inject('PUT', '/v1/users/user-a/notification-preferences', {
      categories: { new_assessment: { email: false } },
      reminderOffsetsHours: [2, 48],
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<Body>().categories.new_assessment).toEqual({
      in_app: true,
      email: false,
      push: true,
    });
    expect(put.json<Body>().reminderOffsetsHours).toEqual([48, 2]);
  });

  it('locks in_app for critical categories', async () => {
    const t = setup();
    for (const category of ['deadline_change', 'class_cancellation']) {
      const r = await t.inject('PUT', '/v1/users/user-a/notification-preferences', {
        categories: { [category]: { in_app: false } },
      });
      expect(r.statusCode).toBe(422);
      expect(r.json<Body>().error.code).toBe('critical_in_app_locked');
    }
    const ok = await t.inject('PUT', '/v1/users/user-a/notification-preferences', {
      categories: { lecture_summary: { in_app: false }, deadline_change: { email: false } },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('validates quiet hours and offsets', async () => {
    const t = setup();
    const bad = [
      { quietHours: { start: '25:00', end: '07:00', timezone: 'America/Sao_Paulo' } },
      { quietHours: { start: '22:00', end: '07:00', timezone: 'Mars/Olympus' } },
      { reminderOffsetsHours: [2, 2] },
      { reminderOffsetsHours: [0] },
      { categories: { unknown: { in_app: true } } },
    ];
    for (const body of bad) {
      expect(
        (await t.inject('PUT', '/v1/users/user-a/notification-preferences', body)).statusCode,
      ).toBe(400);
    }
  });

  it('disabled channels are honoured; in_app-off notifications stay out of the inbox', async () => {
    const t = setup();
    await t.sync();
    await t.inject('PUT', '/v1/users/user-a/notification-preferences', {
      categories: { new_assessment: { in_app: false, email: false, push: false } },
    });
    await t.event('event.published', { calendarEventId: t.calEvent().id });
    expect((await t.inbox('user-a')).items).toHaveLength(0);
    expect(t.email.sent.map((m) => m.to)).not.toContain('a@aluno.example');
  });
});

describe('student notifications — quiet hours', () => {
  it('computes the end of overnight and same-day windows', () => {
    const q = { start: '22:00', end: '07:00', timezone: 'America/Sao_Paulo' };
    // 23:30 local (UTC-3) on 04/11 → ends 07:00 local on 05/11 = 10:00Z
    expect(quietUntil(q, new Date('2026-11-05T02:30:00Z'))?.toISOString()).toBe(
      '2026-11-05T10:00:00.000Z',
    );
    // 05:00 local on 05/11 → same day
    expect(quietUntil(q, new Date('2026-11-05T08:00:00Z'))?.toISOString()).toBe(
      '2026-11-05T10:00:00.000Z',
    );
    expect(quietUntil(q, new Date('2026-11-05T15:00:00Z'))).toBeNull();
    const day = { start: '13:00', end: '14:00', timezone: 'America/Sao_Paulo' };
    expect(quietUntil(day, new Date('2026-11-05T16:30:00Z'))?.toISOString()).toBe(
      '2026-11-05T17:00:00.000Z',
    );
    expect(quietUntil(null, new Date())).toBeNull();
  });

  it('defers email/push during quiet hours (in_app immediate) and flushes after', async () => {
    const t = setup('2026-11-05T02:30:00.000Z'); // 23:30 in São Paulo
    await t.sync();
    const s = validSub();
    const sub = s.body();
    sub.keys.auth = b64url(s.auth);
    await t.inject('POST', '/v1/users/user-a/push-subscriptions', sub);
    await t.inject('PUT', '/v1/users/user-a/notification-preferences', {
      quietHours: { start: '22:00', end: '07:00', timezone: 'America/Sao_Paulo' },
    });
    await t.event('event.published', { calendarEventId: t.calEvent().id });
    expect((await t.inbox('user-a')).items).toHaveLength(1);
    expect(t.email.sent.map((m) => m.to).sort()).toEqual(['b@aluno.example', 'c@aluno.example']);
    expect(t.push.sent).toHaveLength(0);

    const early = await t.inject('POST', '/v1/notifications/flush-deferred', {
      now: '2026-11-05T09:59:00Z',
    });
    expect(early.json<Body>()).toEqual({ flushed: 0, remaining: 2 });
    const flush = await t.inject('POST', '/v1/notifications/flush-deferred', {
      now: '2026-11-05T10:00:00Z',
    });
    expect(flush.json<Body>()).toEqual({ flushed: 2, remaining: 0 });
    expect(t.email.sent.map((m) => m.to)).toContain('a@aluno.example');
    expect(t.push.sent).toHaveLength(1);
  });

  it('drops a deferred delivery if the user disabled the channel meanwhile', async () => {
    const t = setup('2026-11-05T02:30:00.000Z');
    await t.sync();
    await t.inject('PUT', '/v1/users/user-a/notification-preferences', {
      quietHours: { start: '22:00', end: '07:00', timezone: 'America/Sao_Paulo' },
    });
    await t.event('event.published', { calendarEventId: t.calEvent().id });
    await t.inject('PUT', '/v1/users/user-a/notification-preferences', {
      categories: { new_assessment: { email: false } },
    });
    await t.inject('POST', '/v1/notifications/flush-deferred', { now: '2026-11-05T10:00:00Z' });
    expect(t.email.sent.map((m) => m.to)).not.toContain('a@aluno.example');
  });
});

describe('student notifications — reminders', () => {
  it('sends 24 h then 2 h reminders once each, using per-user offsets', async () => {
    const t = setup('2026-11-08T12:00:00.000Z');
    await t.sync();
    await t.inject('PUT', '/v1/users/user-c/notification-preferences', {
      reminderOffsetsHours: [2],
    });
    // exam 10/11 19:00 São Paulo = 22:00Z
    await t.event('event.published', { calendarEventId: t.calEvent().id });
    const run = (now: string) =>
      t.inject('POST', '/v1/reminders/run', { now }).then((r) => r.json<Body>());

    expect((await run('2026-11-09T21:59:00Z')).created).toBe(0);
    expect(await run('2026-11-09T22:00:00Z')).toMatchObject({ created: 2, events: 1 }); // a, b
    expect((await run('2026-11-09T23:00:00Z')).created).toBe(0); // dedup
    expect((await run('2026-11-10T20:00:00Z')).created).toBe(3); // 2 h for everyone
    expect((await run('2026-11-10T22:00:00Z')).created).toBe(0); // event started
    const titles = (await t.inbox('user-a')).items.map((n) => n.title);
    expect(titles).toEqual([
      'Lembrete: Prova em 2 h',
      'Lembrete: Prova amanhã',
      'Nova avaliação/prazo: Prova',
    ]);
    expect((await t.inbox('user-c')).items.map((n) => n.title)).toEqual([
      'Lembrete: Prova em 2 h',
      'Nova avaliação/prazo: Prova',
    ]);
  });

  it('late publication only sends the closest reminder; date change re-arms reminders', async () => {
    const t = setup('2026-11-10T19:00:00.000Z'); // 3 h before the exam
    await t.sync();
    const cal = t.calEvent();
    await t.event('event.published', { calendarEventId: cal.id });
    const run = (now: string) =>
      t.inject('POST', '/v1/reminders/run', { now }).then((r) => r.json<Body>());
    expect((await run('2026-11-10T19:00:00Z')).created).toBe(3); // 24 h (not 2 h yet)
    expect((await run('2026-11-10T20:30:00Z')).created).toBe(3); // 2 h
    t.calendar.events.set(cal.id, { ...cal, eventDate: '2026-11-12', version: 2 });
    t.setNow('2026-11-10T21:00:00Z');
    await t.event('event.updated', { calendarEventId: cal.id });
    expect((await run('2026-11-11T22:00:00Z')).created).toBe(3);
  });

  it('cancelled events and announcements get no reminders', async () => {
    const t = setup('2026-11-10T12:00:00.000Z');
    await t.sync();
    const exam = t.calEvent();
    await t.event('event.published', { calendarEventId: exam.id });
    await t.event('event.published', { calendarEventId: t.calEvent({ type: 'room_change' }).id });
    t.calendar.events.set(exam.id, { ...exam, status: 'cancelled', version: 2 });
    await t.event('event.updated', { calendarEventId: exam.id });
    expect(
      (await t.inject('POST', '/v1/reminders/run', { now: '2026-11-10T21:00:00Z' })).json<Body>(),
    ).toMatchObject({
      created: 0,
      events: 0,
    });
  });
});

describe('push subscriptions & Web Push', () => {
  it('validates, upserts by endpoint, lists and deletes', async () => {
    const t = setup();
    const s = validSub();
    const body = s.body();
    body.keys.auth = b64url(s.auth);
    const bad = await t.inject('POST', '/v1/users/user-a/push-subscriptions', {
      ...body,
      endpoint: 'http://insecure',
    });
    expect(bad.statusCode).toBe(400);
    const short = await t.inject('POST', '/v1/users/user-a/push-subscriptions', {
      ...body,
      keys: { ...body.keys, auth: 'AAAA' },
    });
    expect(short.statusCode).toBe(400);
    const first = (
      await t.inject('POST', '/v1/users/user-a/push-subscriptions', body)
    ).json<Body>();
    const second = (
      await t.inject('POST', '/v1/users/user-a/push-subscriptions', body)
    ).json<Body>();
    expect(second.id).toBe(first.id);
    expect(
      (await t.inject('GET', '/v1/users/user-a/push-subscriptions')).json<Body>().items,
    ).toHaveLength(1);
    expect(
      (await t.inject('DELETE', `/v1/users/user-b/push-subscriptions/${first.id}`)).statusCode,
    ).toBe(404);
    expect(
      (await t.inject('DELETE', `/v1/users/user-a/push-subscriptions/${first.id}`)).statusCode,
    ).toBe(204);
    expect((await t.inject('GET', '/v1/push/vapid-public-key')).json<Body>()).toEqual({
      publicKey: 'BPUB',
    });
  });

  it('removes expired subscriptions (410)', async () => {
    const t = setup();
    await t.sync();
    const s = validSub();
    const body = s.body('https://push.example.com/gone');
    body.keys.auth = b64url(s.auth);
    await t.inject('POST', '/v1/users/user-a/push-subscriptions', body);
    t.push.statusByEndpoint.set('https://push.example.com/gone', 410);
    await t.event('event.published', { calendarEventId: t.calEvent().id });
    expect(
      (await t.inject('GET', '/v1/users/user-a/push-subscriptions')).json<Body>().items,
    ).toHaveLength(0);
  });

  it('VAPID JWT: ES256 header, aud = push origin, exp ≤ 24 h, verifiable signature', () => {
    const keys = generateVapidKeys();
    const now = new Date('2026-11-04T12:00:00Z');
    const jwt = buildVapidJwt('https://fcm.googleapis.com', 'mailto:ops@example.com', keys, now);
    const [h, c, sig] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(fromB64url(h).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(fromB64url(c).toString()) as Record<string, unknown>;
    expect(claims).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: 1793793600 + 12 * 3600,
      sub: 'mailto:ops@example.com',
    });
    expect(fromB64url(sig)).toHaveLength(64); // raw r||s
    const pub = fromB64url(keys.publicKey);
    const key = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) },
      format: 'jwk',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${c}`),
        { key, dsaEncoding: 'ieee-p1363' },
        fromB64url(sig),
      ),
    ).toBe(true);
    expect(() => buildVapidJwt('https://x', 's', keys, now, 25 * 3600)).toThrow();
  });

  it('aes128gcm matches the RFC 8291 Appendix A test vector', () => {
    const out = encryptPayload(
      {
        endpoint: 'https://push.example.net/',
        keys: {
          p256dh:
            'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
          auth: 'BTBZMqHH6r4Tts7J_aSIgg',
        },
      },
      Buffer.from('When I grow up, I want to be a watermelon'),
      {
        salt: fromB64url('DGv6ra1nlYgDCS1FRnbzlw'),
        senderPrivateKey: fromB64url('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
      },
    );
    expect(b64url(out)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('WebPushSender sends an encrypted body the user agent can decrypt, with VAPID headers', async () => {
    const keys = generateVapidKeys();
    const s = validSub();
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(null, { status: 201 }));
    }) as unknown as typeof fetch;
    const sender = new WebPushSender(keys, 'mailto:ops@example.com', fakeFetch, () => new Date());
    const target = {
      endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc',
      keys: { p256dh: b64url(s.ua.getPublicKey()), auth: b64url(s.auth) },
    };
    const res = await sender.send(
      target,
      { title: 'Prazo alterado', body: 'P1 → 17/11' },
      { urgency: 'high', topic: 'evt-1' },
    );
    expect(res).toEqual({ statusCode: 201, expired: false });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['content-encoding']).toBe('aes128gcm');
    expect(headers.urgency).toBe('high');
    expect(headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    const jwtClaims = JSON.parse(fromB64url(headers.authorization!.split('.')[1]!).toString()) as {
      aud: string;
    };
    expect(jwtClaims.aud).toBe('https://updates.push.services.mozilla.com');

    // user-agent side decryption (RFC 8291 §3.4, independent of the sender code)
    const body = calls[0]!.init.body as Buffer;
    const salt = body.subarray(0, 16);
    const idlen = body.readUInt8(20);
    const asPublic = body.subarray(21, 21 + idlen);
    const ct = body.subarray(21 + idlen);
    const h = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();
    const secret = s.ua.computeSecret(asPublic);
    const ikm = h(
      h(s.auth, secret),
      Buffer.concat([
        Buffer.from('WebPush: info\0'),
        s.ua.getPublicKey(),
        asPublic,
        Buffer.from([1]),
      ]),
    );
    const prk = h(salt, ikm);
    const cek = h(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
    const nonce = h(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
    const d = createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    expect(plain.at(-1)).toBe(2);
    expect(JSON.parse(plain.subarray(0, -1).toString())).toEqual({
      title: 'Prazo alterado',
      body: 'P1 → 17/11',
    });
  });
});

describe('student routes — auth', () => {
  function tokenFor(privateKey: KeyObject, sub: string): string {
    const enc = (o: object) => b64url(Buffer.from(JSON.stringify(o)));
    const now = Math.floor(Date.now() / 1000);
    const head = enc({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' });
    const body = enc({
      iss: 'ci-identity',
      aud: 'ci',
      sub,
      iat: now,
      exp: now + 600,
      jti: randomUUID(),
      inst: INST,
      role: 'student',
      pid: randomUUID(),
    });
    return `${head}.${body}.${b64url(edSign(null, Buffer.from(`${head}.${body}`), privateKey))}`;
  }

  it('requires the token subject to match the user when a verifier is configured', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const { app } = buildApp({
      verifyToken: createAccessTokenVerifier({ getKey: () => Promise.resolve(publicKey) }),
      internalToken: 'secret',
    });
    const get = (auth?: string) =>
      app.inject({
        method: 'GET',
        url: '/v1/users/user-a/notifications',
        headers: auth ? { authorization: auth } : {},
      });
    expect((await get()).statusCode).toBe(401);
    expect((await get('Bearer junk')).statusCode).toBe(401);
    expect((await get(`Bearer ${tokenFor(privateKey, 'user-b')}`)).statusCode).toBe(403);
    expect((await get(`Bearer ${tokenFor(privateKey, 'user-a')}`)).statusCode).toBe(200);
    const run = (token?: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/reminders/run',
        payload: {},
        headers: token ? { 'x-internal-token': token } : {},
      });
    expect((await run()).statusCode).toBe(401);
    expect((await run('secret')).statusCode).toBe(200);
  });
});
