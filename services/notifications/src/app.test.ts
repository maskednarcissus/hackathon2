import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { InMemoryAuditClient } from './audit.js';
import { InMemoryChannel, RecipientDirectory } from './channels.js';
import type { Alert } from './domain.js';

const INST = '6f1c2e8a-1b2c-4d5e-8f90-1234567890ab';
const T0 = new Date('2026-11-04T22:00:00.000Z');
const min = (m: number): string => new Date(T0.getTime() + m * 60_000).toISOString();

function setup(opts: { failingChannel?: boolean } = {}) {
  let now = T0;
  const email = new InMemoryChannel('email', opts.failingChannel ? 'relay down' : undefined);
  const audit = new InMemoryAuditClient();
  const { app } = buildApp({
    channels: [email],
    recipients: new RecipientDirectory(
      { [INST]: [{ channel: 'email', address: 'ops@inst.example', minSeverity: 'medium' }] },
      [{ channel: 'email', address: 'noc@ci.example', minSeverity: 'high' }],
    ),
    audit,
    clock: () => now,
  });
  return {
    app,
    email,
    audit,
    setNow: (d: string) => {
      now = new Date(d);
    },
  };
}

const event = (
  type: string,
  data: Record<string, unknown>,
  institutionId: string | null = INST,
) => ({
  eventId: randomUUID(),
  type,
  version: 1,
  occurredAt: T0.toISOString(),
  source: 'test',
  institutionId,
  data,
});

const windowA = {
  scheduledClassId: 'class-A',
  classroomId: 'room-1',
  deviceId: 'dev-1',
  institutionId: INST,
  recordStartAt: min(0),
  recordStopAt: min(110),
};

describe('notifications service', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  const evaluate = async (now: string, body: Record<string, unknown>) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/alerts/evaluate',
      payload: { now, ...body },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ raised: Alert[]; updated: Alert[]; resolved: Alert[] }>();
  };
  const list = async (qs = '') =>
    (await ctx.app.inject({ method: 'GET', url: `/v1/alerts${qs}` })).json<{ alerts: Alert[] }>()
      .alerts;

  it('health', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'ok', service: 'notifications' });
  });

  it('rejects invalid envelopes with a JSON error', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/lifecycle-events',
      payload: { type: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('raises recording_missed after the 5 min grace and auto-resolves on recording.started', async () => {
    expect((await evaluate(min(4), { classWindows: [windowA] })).raised).toHaveLength(0);
    const r = await evaluate(min(5), { classWindows: [windowA] });
    expect(r.raised).toHaveLength(1);
    expect(r.raised[0]).toMatchObject({
      rule: 'recording_missed',
      severity: 'high',
      resourceId: 'class-A',
    });
    expect(ctx.email.sent).toHaveLength(1);
    expect(ctx.email.sent[0]!.recipient).toBe('ops@inst.example');

    const ev = await ctx.app.inject({
      method: 'POST',
      url: '/v1/lifecycle-events',
      payload: event('recording.started', { deviceId: 'dev-1', scheduledClassId: 'class-A' }),
    });
    expect(ev.statusCode).toBe(202);
    expect(ev.json().resolved).toHaveLength(1);
    const [alert] = await list();
    expect(alert).toMatchObject({ status: 'resolved', resolution: 'auto' });
    // once the class has a recording, evaluation does not re-raise
    expect((await evaluate(min(30), { classWindows: [windowA] })).raised).toHaveLength(0);
    expect(ctx.audit.events.map((e) => e.action)).toEqual(['alert.raised', 'alert.resolved']);
  });

  it('skips windows with recording disabled by policy', async () => {
    const r = await evaluate(min(30), { classWindows: [{ ...windowA, recordingEnabled: false }] });
    expect(r.raised).toHaveLength(0);
  });

  it('device_offline: high during a class, low outside, cleared on heartbeat', async () => {
    const dev = {
      deviceId: 'dev-1',
      classroomId: 'room-1',
      institutionId: INST,
      lastSeenAt: min(0),
      diskFreeBytes: 5e9,
    };
    expect((await evaluate(min(3), { devices: [dev], classWindows: [] })).raised).toHaveLength(0);
    // 4 min silent outside class: below the 5 min outside-window threshold
    expect((await evaluate(min(4), { devices: [dev] })).raised).toHaveLength(0);
    const outside = await evaluate(min(6), { devices: [dev] });
    expect(outside.raised[0]).toMatchObject({ rule: 'device_offline', severity: 'low' });
    expect(ctx.email.sent).toHaveLength(0); // low is below every recipient's threshold

    // class starts while still offline → escalated to high and notified
    const during = await evaluate(min(10), {
      devices: [dev],
      classWindows: [{ ...windowA, recordStartAt: min(8), recordStopAt: min(100) }],
    });
    expect(during.updated[0]).toMatchObject({ severity: 'high', status: 'open' });
    expect(ctx.email.sent.map((n) => n.kind)).toEqual(['escalated']);

    const back = await evaluate(min(11), { devices: [{ ...dev, lastSeenAt: min(11) }] });
    expect(back.resolved.map((a) => a.rule)).toEqual(['device_offline']);
  });

  it('dedupes and re-notifies only after the 30 min cooldown', async () => {
    const dev = {
      deviceId: 'dev-9',
      classroomId: 'room-1',
      institutionId: INST,
      lastSeenAt: min(0),
    };
    const w = { ...windowA, deviceId: 'dev-9' };
    await evaluate(min(4), { devices: [dev], classWindows: [w] });
    await evaluate(min(10), { devices: [dev], classWindows: [w] });
    await evaluate(min(20), { devices: [dev], classWindows: [w] });
    const offline = (await list('?rule=device_offline'))[0]!;
    expect(offline.occurrences).toBe(3);
    expect(offline.notificationCount).toBe(1);
    await evaluate(min(34), { devices: [dev], classWindows: [w] });
    expect((await list('?rule=device_offline'))[0]!.notificationCount).toBe(2);
    expect(await list('?status=open')).toHaveLength(2); // device_offline + recording_missed
  });

  it('acknowledged alerts stop reminders; manual resolve is audited', async () => {
    await evaluate(min(6), { classWindows: [windowA] });
    const [alert] = await list();
    const ack = await ctx.app.inject({
      method: 'POST',
      url: `/v1/alerts/${alert!.id}/acknowledge`,
      payload: { actorId: 'admin-1', note: 'técnico a caminho' },
    });
    expect(ack.json().alert).toMatchObject({ status: 'acknowledged', acknowledgedBy: 'admin-1' });
    await evaluate(min(50), { classWindows: [windowA] });
    expect(ctx.email.sent).toHaveLength(1);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/alerts/${alert!.id}/resolve`,
      payload: { actorId: 'admin-1' },
    });
    expect(res.json().alert).toMatchObject({
      status: 'resolved',
      resolution: 'manual',
      resolvedBy: 'admin-1',
    });
    expect(ctx.audit.events.map((e) => e.action)).toEqual([
      'alert.raised',
      'alert.acknowledged',
      'alert.resolved',
    ]);
    expect(ctx.audit.events[1]).toMatchObject({
      actorType: 'admin',
      actorId: 'admin-1',
      resourceType: 'alert',
    });

    // a new occurrence after manual resolution opens a fresh alert
    const again = await evaluate(min(60), { classWindows: [windowA] });
    expect(again.raised).toHaveLength(1);
    expect(again.raised[0]!.id).not.toBe(alert!.id);
  });

  it('404 for unknown alerts', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/alerts/${randomUUID()}/resolve`,
      payload: { actorId: 'a' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('upload.failed raises and recording.uploaded clears failed_upload', async () => {
    const post = (type: string, data: Record<string, unknown>) =>
      ctx.app.inject({ method: 'POST', url: '/v1/lifecycle-events', payload: event(type, data) });
    const r = await post('upload.failed', {
      recordingSessionId: 'rs-1',
      uploadId: 'u-1',
      reason: 'checksum_mismatch',
    });
    expect(r.json().raised).toHaveLength(1);
    const [alert] = await list();
    expect(alert).toMatchObject({
      rule: 'failed_upload',
      severity: 'medium',
      recordingSessionId: 'rs-1',
    });
    expect(alert!.message).toContain('checksum_mismatch');
    const done = await post('recording.uploaded', {
      recordingSessionId: 'rs-1',
      scheduledClassId: 'class-A',
    });
    expect(done.json().resolved).toHaveLength(1);
  });

  it('failed_upload overdue 2 h after recordStopAt', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/lifecycle-events',
      payload: event('recording.started', { scheduledClassId: 'class-A' }),
    });
    expect((await evaluate(min(229), { classWindows: [windowA] })).raised).toHaveLength(0);
    const r = await evaluate(min(230), { classWindows: [windowA] });
    expect(r.raised[0]).toMatchObject({ rule: 'failed_upload', resourceId: 'class-A' });
  });

  it('audio quality: poor=medium, unusable=high (escalation), good clears', async () => {
    const post = (verdict: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/lifecycle-events',
        payload: event('audio.quality_assessed', {
          recordingSessionId: 'rs-2',
          report: { verdict, issues: ['low_snr'] },
        }),
      });
    expect((await post('poor')).json().raised).toHaveLength(1);
    expect((await post('unusable')).json().updated).toHaveLength(1);
    expect((await list())[0]).toMatchObject({ rule: 'poor_audio_quality', severity: 'high' });
    expect((await post('good')).json().resolved).toHaveLength(1);
  });

  it('transcription.failed / completed', async () => {
    const post = (type: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/lifecycle-events',
        payload: event(type, { recordingSessionId: 'rs-3', reason: 'provider timeout' }),
      });
    expect((await post('transcription.failed')).json().raised).toHaveLength(1);
    expect((await post('transcription.completed')).json().resolved).toHaveLength(1);
  });

  it('low_storage below 1 GiB', async () => {
    const dev = { deviceId: 'dev-2', lastSeenAt: min(0), diskFreeBytes: 500 * 1024 ** 2 };
    const r = await evaluate(min(0), { devices: [dev] });
    expect(r.raised[0]).toMatchObject({ rule: 'low_storage', severity: 'medium' });
    expect(
      (await evaluate(min(1), { devices: [{ ...dev, diskFreeBytes: 2 * 1024 ** 3 }] })).resolved,
    ).toHaveLength(1);
  });

  it('uses fallback recipients when institution is unknown; filters by severity', async () => {
    await evaluate(min(6), { classWindows: [{ ...windowA, institutionId: null }] });
    expect(ctx.email.sent.map((n) => n.recipient)).toEqual(['noc@ci.example']);
  });

  it('records failed deliveries without failing the request', async () => {
    const failing = setup({ failingChannel: true });
    const res = await failing.app.inject({
      method: 'POST',
      url: '/v1/alerts/evaluate',
      payload: { now: min(6), classWindows: [windowA] },
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().raised[0].id as string;
    const detail = await failing.app.inject({ method: 'GET', url: `/v1/alerts/${id}` });
    expect(detail.json().deliveries[0]).toMatchObject({ status: 'failed', error: 'relay down' });
  });

  it('audit outage is non-fatal', async () => {
    const { app } = buildApp({
      audit: { record: () => Promise.reject(new Error('audit down')) },
      clock: () => T0,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/alerts/evaluate',
      payload: { now: min(6), classWindows: [windowA] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().raised).toHaveLength(1);
  });

  it('filters alerts by classroom and severity', async () => {
    await evaluate(min(6), {
      classWindows: [windowA, { ...windowA, scheduledClassId: 'class-B', classroomId: 'room-2' }],
      devices: [
        { deviceId: 'dev-3', classroomId: 'room-2', lastSeenAt: min(5), diskFreeBytes: 10 },
      ],
    });
    expect((await list('?classroomId=room-2')).map((a) => a.rule).sort()).toEqual([
      'low_storage',
      'recording_missed',
    ]);
    expect((await list('?severity=medium')).map((a) => a.rule)).toEqual(['low_storage']);
    const bad = await ctx.app.inject({ method: 'GET', url: '/v1/alerts?severity=urgent' });
    expect(bad.statusCode).toBe(400);
  });
});
