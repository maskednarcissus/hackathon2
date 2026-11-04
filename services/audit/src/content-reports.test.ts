import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { InMemoryContentReportRepository } from './content-reports.js';
import { InMemoryEventPublisher } from './events.js';
import { InMemoryAuditRepository } from './repository.js';

const INST = '11111111-1111-4111-8111-111111111111';
const SECTION = '55555555-5555-4555-8555-555555555555';
const STUDENT = '66666666-6666-4666-8666-666666666666';
const PROF = '77777777-7777-4777-8777-777777777777';
const EVENT = '88888888-8888-4888-8888-888888888888';

function setup() {
  const events = new InMemoryEventPublisher();
  const audit = new InMemoryAuditRepository();
  const app = buildApp({
    repository: audit,
    contentReports: new InMemoryContentReportRepository(),
    events,
  });
  return { app, events, audit };
}

const report = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  reporterId: STUDENT,
  reporterRole: 'student',
  institutionId: INST,
  resourceType: 'calendar_event',
  resourceId: EVENT,
  classSectionId: SECTION,
  reason: 'incorrect_date',
  details: 'O professor disse dia 21, não 20.',
  ...overrides,
});

describe('content reports (3.15)', () => {
  it('stores, audits and emits a report; resolves it once', async () => {
    const { app, events, audit } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/content-reports', payload: report() });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string; status: string }>();
    expect(created.status).toBe('open');
    expect(events.events[0]).toMatchObject({
      type: 'content.reported',
      institutionId: INST,
      data: { contentReportId: created.id, reason: 'incorrect_date' },
    });
    const chain = await audit.chain(INST);
    expect(chain[0]).toMatchObject({
      action: 'content.reported',
      actorId: STUDENT,
      actorType: 'student',
      resourceId: EVENT,
    });

    const dup = await app.inject({ method: 'POST', url: '/v1/content-reports', payload: report() });
    expect(dup.statusCode).toBe(200);
    expect(dup.json<{ id: string; duplicate: boolean }>()).toMatchObject({
      id: created.id,
      duplicate: true,
    });

    const list = (
      await app.inject({ url: `/v1/content-reports?classSectionId=${SECTION}&status=open` })
    ).json<{ items: unknown[] }>();
    expect(list.items).toHaveLength(1);

    const resolved = await app.inject({
      method: 'POST',
      url: `/v1/content-reports/${created.id}/resolve`,
      payload: { actorId: PROF, resolution: 'corrected', notes: 'Data corrigida para 21/11.' },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      status: 'resolved',
      resolution: 'corrected',
      resolvedBy: PROF,
    });
    expect(events.events[1]).toMatchObject({ type: 'content.report_resolved' });
    expect((await audit.chain(INST))[1]).toMatchObject({
      action: 'content.report_resolved',
      actorType: 'professor',
    });

    const again = await app.inject({
      method: 'POST',
      url: `/v1/content-reports/${created.id}/resolve`,
      payload: { actorId: PROF, resolution: 'invalid' },
    });
    expect(again.statusCode).toBe(409);
    expect(
      (
        await app.inject({ url: `/v1/content-reports?classSectionId=${SECTION}&status=open` })
      ).json<{ items: unknown[] }>().items,
    ).toHaveLength(0);
  });

  it('accepts composite resource ids for transcript segments and validates input', async () => {
    const { app, audit } = setup();
    const seg = await app.inject({
      method: 'POST',
      url: '/v1/content-reports',
      payload: report({
        resourceType: 'transcript_segment',
        resourceId: `${EVENT}:42`,
        reason: 'transcription_error',
      }),
    });
    expect(seg.statusCode).toBe(201);
    expect((await audit.chain(INST))[0]).toMatchObject({
      resourceId: null,
      metadata: { resourceId: `${EVENT}:42` },
    });
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/content-reports',
      payload: report({ reason: 'boring' }),
    });
    expect(bad.statusCode).toBe(400);
    const noFilter = await app.inject({ url: '/v1/content-reports' });
    expect(noFilter.statusCode).toBe(400);
    const missing = await app.inject({ url: `/v1/content-reports/${EVENT}` });
    expect(missing.statusCode).toBe(404);
  });
});

describe('phase 2/3 catalog', () => {
  it('accepts catalogued and open-namespace actions, rejects unknown governed ones, allows null actor', async () => {
    const { app } = setup();
    const ok = [
      'transcript.corrected',
      'ai.generation',
      'auth.login_failed',
      'auth.refresh_reuse_detected',
      'event.published',
      'lecture.viewed',
      'calendar.feed_token_rotated',
    ];
    for (const action of ok) {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/audit-events',
        payload: { action, resourceType: 'x', actorId: null },
      });
      expect(r.statusCode, action).toBe(201);
    }
    for (const action of [
      'transcript.deleted',
      'auth.password_dumped',
      'ai.anything',
      'content.hidden',
    ]) {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/audit-events',
        payload: { action, resourceType: 'x' },
      });
      expect(r.statusCode, action).toBe(422);
    }
  });
});
