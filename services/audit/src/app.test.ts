import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { canonicalJson } from './chain.js';
import { InMemoryAuditRepository } from './repository.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';

function setup(): { app: ReturnType<typeof buildApp>; repo: InMemoryAuditRepository } {
  const repo = new InMemoryAuditRepository();
  let t = Date.parse('2026-11-04T12:00:00.000Z');
  const app = buildApp({ repository: repo, clock: { now: () => new Date((t += 1000)) } });
  return { app, repo };
}

async function post(app: ReturnType<typeof buildApp>, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/v1/audit-events', payload: body });
}

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe('audit service', () => {
  it('appends a hash-chained event per tenant', async () => {
    const { app } = setup();
    const a = await post(app, {
      tenantId: TENANT,
      actorType: 'device',
      action: 'recording.started',
      resourceType: 'recording_session',
      resourceId: REC,
    });
    const b = await post(app, {
      tenantId: TENANT,
      action: 'upload.completed',
      resourceType: 'recording_session',
      resourceId: REC,
    });
    const c = await post(app, {
      tenantId: OTHER,
      action: 'device.registered',
      resourceType: 'device',
    });
    expect(a.statusCode).toBe(201);
    const ea = a.json<{ sequence: number; prevHash: string; hash: string }>();
    const eb = b.json<{ sequence: number; prevHash: string }>();
    const ec = c.json<{ sequence: number; prevHash: string }>();
    expect(ea.sequence).toBe(1);
    expect(ea.prevHash).toBe('0'.repeat(64));
    expect(eb.sequence).toBe(2);
    expect(eb.prevHash).toBe(ea.hash);
    expect(ec.sequence).toBe(1);
    expect(ec.prevHash).toBe('0'.repeat(64));
  });

  it('rejects governed actions outside the catalog and malformed bodies', async () => {
    const { app } = setup();
    const r1 = await post(app, { action: 'recording.deleted', resourceType: 'recording_session' });
    expect(r1.statusCode).toBe(422);
    expect(r1.json<{ error: { code: string } }>().error.code).toBe('unknown_action');
    const r2 = await post(app, {
      action: 'lecture.viewed',
      resourceType: 'lecture',
      actorType: 'robot',
    });
    expect(r2.statusCode).toBe(400);
    const r3 = await post(app, { action: 'lecture.viewed', resourceType: 'lecture' });
    expect(r3.statusCode).toBe(201);
  });

  it('exposes no update or delete routes', async () => {
    const { app } = setup();
    const created = (
      await post(app, { action: 'device.registered', resourceType: 'device' })
    ).json<{ id: string }>();
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const r = await app.inject({ method, url: `/v1/audit-events/${created.id}`, payload: {} });
      expect(r.statusCode).toBe(404);
    }
  });

  it('filters and paginates with a cursor', async () => {
    const { app } = setup();
    for (let i = 0; i < 5; i++) {
      await post(app, { tenantId: TENANT, action: 'upload.started', resourceType: 'upload' });
    }
    await post(app, { tenantId: OTHER, action: 'upload.started', resourceType: 'upload' });
    const p1 = (await app.inject({ url: `/v1/audit-events?tenantId=${TENANT}&limit=3` })).json<{
      items: unknown[];
      nextCursor: string | null;
    }>();
    expect(p1.items).toHaveLength(3);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = (
      await app.inject({
        url: `/v1/audit-events?tenantId=${TENANT}&limit=3&cursor=${p1.nextCursor ?? ''}`,
      })
    ).json<{ items: unknown[]; nextCursor: string | null }>();
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    const bad = await app.inject({ url: '/v1/audit-events?cursor=eA' });
    expect(bad.statusCode).toBe(400);
  });

  it('verifies the chain and reports the first broken link after tampering', async () => {
    const { app, repo } = setup();
    for (const action of ['recording.started', 'recording.stopped', 'upload.completed']) {
      await post(app, {
        tenantId: TENANT,
        action,
        resourceType: 'recording_session',
        resourceId: REC,
      });
    }
    const ok = (await app.inject({ url: `/v1/audit-events/verify?tenantId=${TENANT}` })).json<{
      valid: boolean;
      eventCount: number;
    }>();
    expect(ok).toMatchObject({ valid: true, eventCount: 3 });

    const chain = await repo.chain(TENANT);
    const second = chain[1];
    if (!second) throw new Error('missing event');
    second.action = 'recording.missed'; // tamper with stored record
    const broken = (await app.inject({ url: `/v1/audit-events/verify?tenantId=${TENANT}` })).json<{
      valid: boolean;
      firstBrokenLink: { sequence: number; reason: string };
    }>();
    expect(broken.valid).toBe(false);
    expect(broken.firstBrokenLink).toMatchObject({ sequence: 2, reason: 'hash_mismatch' });
  });

  it('returns the ordered lifecycle timeline of a recording', async () => {
    const { app } = setup();
    await post(app, {
      action: 'upload.completed',
      resourceType: 'upload',
      metadata: { recordingSessionId: REC },
      occurredAt: '2026-11-04T13:30:00-03:00',
    });
    await post(app, {
      action: 'recording.started',
      resourceType: 'recording_session',
      resourceId: REC,
      occurredAt: '2026-11-04T15:00:00Z',
    });
    await post(app, {
      action: 'transcription.completed',
      resourceType: 'transcript',
      metadata: { recordingSessionId: REC },
      occurredAt: '2026-11-04T18:00:00Z',
    });
    await post(app, { action: 'device.registered', resourceType: 'device' });
    const res = (await app.inject({ url: `/v1/recordings/${REC}/lifecycle` })).json<{
      timeline: { action: string; occurredAt: string }[];
    }>();
    expect(res.timeline.map((e) => e.action)).toEqual([
      'recording.started',
      'upload.completed',
      'transcription.completed',
    ]);
    expect(res.timeline[1]?.occurredAt).toBe('2026-11-04T16:30:00.000Z');
  });
});

describe('integration shapes', () => {
  it('accepts institutionId as an alias of tenantId and service-name actor ids', async () => {
    const { app, repo } = setup();
    const r = await post(app, {
      institutionId: TENANT,
      actorId: 'speaker-diarization',
      action: 'diarization.completed',
      resourceType: 'transcript',
      metadata: { speakerCount: 2 },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      tenantId: TENANT,
      actorId: null,
      metadata: { speakerCount: 2, actorLabel: 'speaker-diarization' },
    });
    expect(await repo.chain(TENANT)).toHaveLength(1);

    const noMeta = (
      await post(app, {
        institutionId: TENANT,
        actorId: 'transcription',
        action: 'transcription.started',
        resourceType: 'recording_session',
      })
    ).json<{ metadata: unknown; occurredAt: string }>();
    expect(noMeta.metadata).toEqual({ actorLabel: 'transcription' });
    expect(noMeta.occurredAt).toBeTruthy();

    const uuidActor = (
      await post(app, {
        tenantId: TENANT,
        actorId: REC,
        action: 'recording.uploaded',
        resourceType: 'recording_session',
      })
    ).json<{ actorId: string; metadata: unknown }>();
    expect(uuidActor).toMatchObject({ actorId: REC, metadata: null });

    const conflict = await post(app, {
      tenantId: TENANT,
      institutionId: OTHER,
      action: 'upload.started',
      resourceType: 'upload',
    });
    expect(conflict.statusCode).toBe(400);
  });

  it('accepts every action emitted by the platform services', async () => {
    const { app } = setup();
    const emitted =
      'alert.acknowledged alert.raised alert.resolved audio.quality_assessed audio.segmented auth.locked auth.login_failed auth.login_succeeded auth.logout auth.refresh_reuse_detected auth.user_created calendar.event_published calendar.event_updated calendar.feed_token_rotated content.report_resolved content.reported device.assigned device.certificate_revoked device.heartbeat_missed device.provisioning_token_created device.registered device.status_changed device.unassigned diarization.completed diarization.failed event.confirmed event.deduplicated event.edited event.extracted event.published event.rejected event.updated ai.generation lecture.structured recording.class_identified recording.metadata_received recording.missed recording.scheduled recording.segmented recording.started recording.stopped recording.uploaded transcript.corrected transcript.created transcription.completed transcription.failed transcription.started upload.completed upload.failed upload.started';
    for (const action of emitted.split(' ')) {
      const r = await post(app, { action, resourceType: 'x' });
      expect(r.statusCode, action).toBe(201);
    }
  });
});
