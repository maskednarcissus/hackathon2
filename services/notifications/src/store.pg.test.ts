import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { InMemoryChannel, RecipientDirectory } from './channels.js';
import { AlertEngine } from './engine.js';
import { MapOrganizationClient } from './incidents/organization.js';
import { PgAlertStore } from './store.pg.js';
import { MapCalendarEventSource, type CalendarEventDetails } from './student/directories.js';
import { InMemoryEmailSender } from './student/email.js';
import { PgStudentStore } from './student/store.pg.js';
import { FakePushSender } from './student/webpush.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from './test/pg-harness.js';
import { InMemoryAuditClient } from './audit.js';

const T0 = new Date('2026-11-04T12:00:00.000Z');
const min = (m: number): string => new Date(T0.getTime() + m * 60_000).toISOString();

interface Body {
  raised: { id: string; rule: string }[];
  resolved: unknown[];
  duplicate: boolean;
  studentNotifications: { created: number; duplicates: number; category: string };
  items: Record<string, unknown>[];
  unreadCount: number;
  total: number;
  flushed: number;
  remaining: number;
  created: number;
  status: string;
  error: { code: string };
}

describe.skipIf(!TEST_DATABASE_URL)('notifications on PostgreSQL', () => {
  let db: TestDatabase;
  let INST: string;
  let now = T0;
  const classroom = randomUUID();
  const campus = randomUUID();
  const section = randomUUID();

  const setup = () => {
    const org = new MapOrganizationClient();
    org.classrooms.set(classroom, {
      classroomId: classroom,
      classroomName: 'Sala 101',
      campusId: campus,
      campusName: 'Campus Norte',
      institutionId: INST,
    });
    const email = new InMemoryEmailSender();
    const push = new FakePushSender();
    const channel = new InMemoryChannel('email');
    const calendar = new MapCalendarEventSource();
    const audit = new InMemoryAuditClient();
    const { app, engine } = buildApp({
      store: new PgAlertStore(db.pool),
      studentStore: new PgStudentStore(db.pool),
      clock: () => now,
      organization: org,
      channels: [channel],
      recipients: new RecipientDirectory({}, [
        { channel: 'email', address: 'noc@x', minSeverity: 'low' },
      ]),
      audit,
      calendar,
      email,
      push,
    });
    const envelope = (type: string, data: Record<string, unknown>, eventId = randomUUID()) => ({
      eventId,
      type,
      version: 1,
      occurredAt: now.toISOString(),
      source: 'test',
      institutionId: INST,
      data,
    });
    return { app, engine, channel, calendar, email, push, envelope };
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    INST = db.institutionId;
  }, 60_000);
  afterAll(async () => {
    await db?.drop();
  });

  it('alerts: raise with campus, dedupe, auto-resolve, deliveries and processed-event idempotency', async () => {
    const t = setup();
    const cls = randomUUID();
    const window = {
      scheduledClassId: cls,
      classroomId: classroom,
      recordStartAt: min(0),
      recordStopAt: min(100),
    };
    const r1 = await t.app.inject({
      method: 'POST',
      url: '/v1/alerts/evaluate',
      payload: { now: min(6), classWindows: [window] },
    });
    expect(r1.json<Body>().raised).toHaveLength(1);
    const r2 = await t.app.inject({
      method: 'POST',
      url: '/v1/alerts/evaluate',
      payload: { now: min(7), classWindows: [window] },
    });
    expect(r2.json<Body>().raised).toHaveLength(0);
    const list = await t.app.inject({
      method: 'GET',
      url: `/v1/incidents?institutionId=${INST}&campusId=${campus}`,
    });
    const [inc] = list.json<Body>().items;
    expect(inc).toMatchObject({
      type: 'recording_missed',
      campusName: 'Campus Norte',
      occurrences: 2,
      slaBreached: false,
    });

    const env = t.envelope('recording.started', { scheduledClassId: cls, deviceId: randomUUID() });
    const ev = await t.app.inject({ method: 'POST', url: '/v1/lifecycle-events', payload: env });
    expect(ev.json<Body>().resolved).toHaveLength(1);
    const dup = await t.app.inject({ method: 'POST', url: '/v1/lifecycle-events', payload: env });
    expect(dup.json<Body>().duplicate).toBe(true);
    // the class mark persists: evaluating again does not re-raise
    const r3 = await t.app.inject({
      method: 'POST',
      url: '/v1/alerts/evaluate',
      payload: { now: min(30), classWindows: [window] },
    });
    expect(r3.json<Body>().raised).toHaveLength(0);
    const detail = await t.app.inject({ method: 'GET', url: `/v1/alerts/${String(inc!.id)}` });
    expect(detail.json<{ alert: { status: string }; deliveries: unknown[] }>()).toMatchObject({
      alert: { status: 'resolved' },
    });
    // raised + resolved notices
    expect(detail.json<{ deliveries: unknown[] }>().deliveries).toHaveLength(2);
  });

  it('concurrent raises of the same condition create exactly one alert (partial unique index)', async () => {
    const stores = Array.from({ length: 5 }, () => new PgAlertStore(db.pool));
    const channel = new InMemoryChannel('email');
    const device = randomUUID();
    const engines = stores.map(
      (store) =>
        new AlertEngine({
          store,
          channels: [channel],
          recipients: new RecipientDirectory({}, [
            { channel: 'email', address: 'noc@x', minSeverity: 'low' },
          ]),
          audit: new InMemoryAuditClient(),
          clock: () => new Date(min(20)),
          logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        }),
    );
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        engines[i % engines.length]!.evaluate({
          now: min(20),
          classWindows: [],
          devices: [{ deviceId: device, lastSeenAt: min(0), diskFreeBytes: null }],
        }),
      ),
    );
    const rows = await db.pool.query(
      "SELECT occurrences FROM alerts WHERE dedupe_key = $1 AND status <> 'resolved'",
      [`device_offline:${device}`],
    );
    expect(rows.rowCount).toBe(1);
    expect(
      channel.sent.filter((n) => n.alert.deviceId === device && n.kind === 'raised'),
    ).toHaveLength(1);
  });

  it('incident workflow, timeline and stats', async () => {
    const t = setup();
    const device = randomUUID();
    await t.app.inject({
      method: 'POST',
      url: '/v1/alerts/evaluate',
      payload: {
        now: min(40),
        devices: [
          { deviceId: device, classroomId: classroom, lastSeenAt: min(40), diskFreeBytes: 5 },
        ],
      },
    });
    const [inc] = (
      await t.app.inject({
        method: 'GET',
        url: `/v1/incidents?type=low_storage&assignee=unassigned`,
      })
    ).json<Body>().items;
    const id = String(inc!.id);
    now = new Date(min(50));
    const tech = randomUUID();
    await t.app.inject({
      method: 'POST',
      url: `/v1/incidents/${id}/assign`,
      payload: { assigneeId: tech, actorId: 'coord' },
    });
    await t.app.inject({
      method: 'POST',
      url: `/v1/incidents/${id}/status`,
      payload: { status: 'in_progress', actorId: tech },
    });
    await t.app.inject({
      method: 'POST',
      url: `/v1/incidents/${id}/comments`,
      payload: { actorId: tech, body: 'Limpando disco' },
    });
    now = new Date(min(100));
    const res = await t.app.inject({
      method: 'POST',
      url: `/v1/incidents/${id}/status`,
      payload: { status: 'resolved', actorId: tech, resolutionCode: 'configuration' },
    });
    expect(res.json()).toMatchObject({
      status: 'resolved',
      resolutionCode: 'configuration',
      assigneeId: tech,
      acknowledgedAt: min(50),
      comments: [{ body: 'Limpando disco', actorId: tech }],
    });
    expect(res.json<{ timeline: { action: string }[] }>().timeline.map((e) => e.action)).toEqual([
      'raised',
      'assigned',
      'in_progress',
      'commented',
      'resolved',
    ]);
    const stats = await t.app.inject({
      method: 'GET',
      url: `/v1/incidents/stats?institutionId=${INST}&from=${min(39)}&to=${min(41)}`,
    });
    expect(stats.json()).toMatchObject({
      mttaMinutes: 10,
      mttrMinutes: 60,
      raised: 1,
      resolved: 1,
    });
  });

  it('student notifications: fan-out, dedupe, inbox, preferences, push, quiet hours with concurrent flush', async () => {
    const t = setup();
    now = new Date('2026-11-05T02:30:00.000Z'); // 23:30 São Paulo
    const users = Array.from({ length: 3 }, () => ({
      studentId: randomUUID(),
      userId: randomUUID(),
    }));
    await t.app.inject({
      method: 'POST',
      url: '/v1/sync/enrollments',
      payload: {
        institutionId: INST,
        enrollments: users.map((u, i) => ({
          ...u,
          classSectionId: section,
          email: `s${i}@x.example`,
        })),
      },
    });
    const quietUser = users[0]!.userId;
    const put = await t.app.inject({
      method: 'PUT',
      url: `/v1/users/${quietUser}/notification-preferences`,
      payload: {
        quietHours: { start: '22:00', end: '07:00', timezone: 'America/Sao_Paulo' },
        categories: { lecture_summary: { email: true } },
        reminderOffsetsHours: [2, 24],
      },
    });
    expect(put.statusCode).toBe(200);
    const prefs = (
      await t.app.inject({ method: 'GET', url: `/v1/users/${quietUser}/notification-preferences` })
    ).json<Record<string, unknown>>();
    expect(prefs).toMatchObject({
      quietHours: { start: '22:00', end: '07:00', timezone: 'America/Sao_Paulo' },
      reminderOffsetsHours: [24, 2],
      categories: { lecture_summary: { in_app: true, email: true, push: false } },
    });
    const sub = await t.app.inject({
      method: 'POST',
      url: `/v1/users/${quietUser}/push-subscriptions`,
      payload: {
        endpoint: 'https://push.example.com/a',
        keys: {
          p256dh: Buffer.alloc(65, 4).toString('base64url'),
          auth: Buffer.alloc(16, 2).toString('base64url'),
        },
      },
    });
    expect(sub.statusCode).toBe(201);

    const cal: CalendarEventDetails = {
      id: randomUUID(),
      institutionId: INST,
      courseId: null,
      classSectionId: section,
      extractedEventId: randomUUID(),
      type: 'examination',
      title: 'P1',
      eventDate: '2026-11-10',
      eventTime: '19:00',
      timezone: 'America/Sao_Paulo',
      status: 'published',
      version: 1,
    };
    t.calendar.events.set(cal.id, cal);
    const pub = await t.app.inject({
      method: 'POST',
      url: '/v1/lifecycle-events',
      payload: t.envelope('event.published', {
        eventId: cal.extractedEventId,
        calendarEventId: cal.id,
      }),
    });
    expect(pub.json<Body>().studentNotifications).toMatchObject({ created: 3 });
    const again = await t.app.inject({
      method: 'POST',
      url: '/v1/lifecycle-events',
      payload: t.envelope('event.published', { calendarEventId: cal.id }),
    });
    expect(again.json<Body>().studentNotifications).toMatchObject({ created: 0, duplicates: 3 });
    expect(t.email.sent).toHaveLength(2); // quiet user deferred

    const inbox = (
      await t.app.inject({ method: 'GET', url: `/v1/users/${quietUser}/notifications?unread=true` })
    ).json<Body>();
    expect(inbox.unreadCount).toBe(1);
    expect(inbox.items[0]).toMatchObject({
      category: 'new_assessment',
      readAt: null,
      link: `/calendario/${cal.id}`,
    });

    // date change detected through the persisted tracked event (DATE/TIME round trip)
    now = new Date('2026-11-05T13:00:00.000Z');
    t.calendar.events.set(cal.id, { ...cal, eventDate: '2026-11-12', version: 2 });
    const upd = await t.app.inject({
      method: 'POST',
      url: '/v1/lifecycle-events',
      payload: t.envelope('event.updated', { eventId: cal.extractedEventId }),
    });
    expect(upd.json<Body>().studentNotifications).toMatchObject({
      category: 'deadline_change',
      created: 3,
    });

    // two flushers race: each deferred item is delivered once
    const [a, b] = await Promise.all([
      t.app.inject({
        method: 'POST',
        url: '/v1/notifications/flush-deferred',
        payload: { now: '2026-11-05T10:00:00Z' },
      }),
      t.app.inject({
        method: 'POST',
        url: '/v1/notifications/flush-deferred',
        payload: { now: '2026-11-05T10:00:00Z' },
      }),
    ]);
    expect(a.json<Body>().flushed + b.json<Body>().flushed).toBe(2); // email + push of the quiet user
    expect(t.push.sent.filter((p) => p.message.title.startsWith('Nova'))).toHaveLength(1);

    const readAll = await t.app.inject({
      method: 'POST',
      url: `/v1/users/${quietUser}/notifications/read-all`,
    });
    expect(readAll.json()).toMatchObject({ updated: 2 });

    // reminders from tracked events
    const run = await t.app.inject({
      method: 'POST',
      url: '/v1/reminders/run',
      payload: { now: '2026-11-11T22:00:00Z' },
    });
    expect(run.json<Body>().created).toBe(3);
  });

  it('data subject rights: access then deletion', async () => {
    const t = setup();
    const studentId = randomUUID();
    const userId = randomUUID();
    const sec = randomUUID();
    await t.app.inject({
      method: 'POST',
      url: '/v1/sync/enrollments',
      payload: {
        institutionId: INST,
        enrollments: [{ studentId, userId, classSectionId: sec, email: 'a@x.example' }],
      },
    });
    await t.app.inject({
      method: 'POST',
      url: '/v1/lifecycle-events',
      payload: t.envelope('lecture.structured', {
        scheduledClassId: randomUUID(),
        classSectionId: sec,
        lectureSummaryId: randomUUID(),
      }),
    });
    await t.app.inject({
      method: 'PUT',
      url: `/v1/users/${userId}/notification-preferences`,
      payload: { reminderOffsetsHours: [12] },
    });
    const payload = {
      subjectType: 'student',
      subjectId: studentId,
      requestId: randomUUID(),
      institutionId: INST,
    };
    const access = await t.app.inject({ method: 'POST', url: '/internal/v1/dsr/access', payload });
    const subjects = access.json<{
      items: { subjects: { userId: string; notifications: unknown[] }[] };
    }>().items.subjects;
    expect(subjects.map((s) => s.userId)).toEqual([userId]);
    expect(subjects[0]!.notifications).toHaveLength(1);
    const del = await t.app.inject({ method: 'POST', url: '/internal/v1/dsr/deletion', payload });
    expect(del.json()).toMatchObject({ status: 'completed' });
    const left = await db.pool.query(
      `SELECT (SELECT count(*) FROM user_notifications WHERE user_id = $1) AS n,
              (SELECT count(*) FROM notification_preferences WHERE user_id = $1) AS p,
              (SELECT email FROM notification_enrollments WHERE user_id = $1) AS e`,
      [userId],
    );
    expect(left.rows[0]).toEqual({ n: '0', p: '0', e: null });
  });
});
