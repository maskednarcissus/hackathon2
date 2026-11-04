import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { PgAuditRepository, PgContentReportRepository } from './repository.pg.js';
import {
  createTestDatabase,
  seedOrganization,
  TEST_DATABASE_URL,
  type TestDatabase,
} from './test/pg.js';

const INST = '11111111-1111-4111-8111-111111111111';
const HOLDING = '10000000-0000-4000-8000-000000000000';
const REC = '33333333-3333-4333-8333-333333333333';
const STUDENT = '66666666-6666-4666-8666-666666666666';
const SECTION = '55555555-5555-4555-8555-555555555555';

describe.skipIf(!TEST_DATABASE_URL)('audit on Postgres', () => {
  let db: TestDatabase;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    db = await createTestDatabase(TEST_DATABASE_URL ?? '');
    await seedOrganization(db.pool, { holdingId: HOLDING, institutionId: INST });
    app = buildApp({
      repository: new PgAuditRepository(db.pool),
      contentReports: new PgContentReportRepository(db.pool),
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/v1/audit-events', payload });

  it('appends a linear hash chain under concurrent writers', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        post({
          tenantId: INST,
          actorType: 'device',
          action: 'upload.started',
          resourceType: 'upload',
          metadata: { recordingSessionId: REC, i, nested: { b: 1, a: [1, 2] } },
        }),
      ),
    );
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    const sequences = results
      .map((r) => r.json<{ sequence: number }>().sequence)
      .sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    const verify = (await app.inject({ url: `/v1/audit-events/verify?tenantId=${INST}` })).json<{
      valid: boolean;
      eventCount: number;
    }>();
    expect(verify).toMatchObject({ valid: true, eventCount: 25 });
    // global chain (no tenant) is independent
    const g = await post({
      action: 'device.registered',
      resourceType: 'device',
      actorId: 'device-management',
    });
    expect(g.json()).toMatchObject({
      sequence: 1,
      tenantId: null,
      actorId: null,
      metadata: { actorLabel: 'device-management' },
    });
  });

  it('is append-only at the database level', async () => {
    await expect(
      db.pool.query("UPDATE audit_events SET action = 'recording.missed'"),
    ).rejects.toThrow(/append-only/);
    await expect(db.pool.query('DELETE FROM audit_events')).rejects.toThrow(/append-only/);
  });

  it('paginates with a cursor, filters and builds the recording lifecycle', async () => {
    const p1 = (await app.inject({ url: `/v1/audit-events?tenantId=${INST}&limit=10` })).json<{
      items: { sequence: number }[];
      nextCursor: string | null;
    }>();
    expect(p1.items).toHaveLength(10);
    const p2 = (
      await app.inject({
        url: `/v1/audit-events?tenantId=${INST}&limit=20&cursor=${p1.nextCursor ?? ''}`,
      })
    ).json<{ items: unknown[]; nextCursor: string | null }>();
    expect(p2.items).toHaveLength(15);
    expect(p2.nextCursor).toBeNull();
    await post({
      tenantId: INST,
      action: 'recording.started',
      resourceType: 'recording_session',
      resourceId: REC,
      occurredAt: '2026-11-04T10:00:00Z',
    });
    const life = (await app.inject({ url: `/v1/recordings/${REC}/lifecycle` })).json<{
      timeline: { action: string }[];
    }>();
    expect(life.timeline[0]?.action).toBe('recording.started');
    expect(life.timeline).toHaveLength(26);
  });

  it('accepts the Phase 5 group_executive actor type', async () => {
    const r = await post({
      tenantId: INST,
      actorType: 'group_executive',
      actorId: HOLDING,
      action: 'lecture.viewed',
      resourceType: 'report',
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ actorType: 'group_executive' });
  });

  it('rejects unknown tenants with 422', async () => {
    const r = await post({
      tenantId: '99999999-9999-4999-8999-999999999999',
      action: 'upload.started',
      resourceType: 'upload',
    });
    expect(r.statusCode).toBe(422);
    expect(r.json<{ error: { code: string } }>().error.code).toBe('unknown_tenant');
  });

  it('stores content reports and serves DSR access/deletion', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/content-reports',
      payload: {
        reporterId: STUDENT,
        reporterRole: 'student',
        institutionId: INST,
        resourceType: 'transcript_segment',
        resourceId: `${REC}:4`,
        classSectionId: SECTION,
        reason: 'transcription_error',
        details: 'palavra errada',
      },
    });
    expect(created.statusCode).toBe(201);
    const dup = await app.inject({
      method: 'POST',
      url: '/v1/content-reports',
      payload: {
        reporterId: STUDENT,
        reporterRole: 'student',
        institutionId: INST,
        resourceType: 'transcript_segment',
        resourceId: `${REC}:4`,
        classSectionId: SECTION,
        reason: 'other',
      },
    });
    expect(dup.json<{ duplicate: boolean }>().duplicate).toBe(true);
    const id = created.json<{ id: string }>().id;
    const resolved = await app.inject({
      method: 'POST',
      url: `/v1/content-reports/${id}/resolve`,
      payload: { actorId: SECTION, resolution: 'corrected' },
    });
    expect(resolved.json()).toMatchObject({ status: 'resolved', resolution: 'corrected' });
    expect(
      (
        await app.inject({ url: `/v1/content-reports?classSectionId=${SECTION}&status=resolved` })
      ).json<{ items: unknown[] }>().items,
    ).toHaveLength(1);

    const payload = {
      subjectType: 'student',
      subjectId: STUDENT,
      requestId: REC,
      institutionId: INST,
    };
    const access = (
      await app.inject({ method: 'POST', url: '/internal/v1/dsr/access', payload })
    ).json<{ items: { auditEvents: { action: string }[]; contentReports: unknown[] } }>();
    expect(access.items.auditEvents.map((e) => e.action)).toEqual(['content.reported']);
    expect(access.items.contentReports).toHaveLength(1);
    const del = (
      await app.inject({ method: 'POST', url: '/internal/v1/dsr/deletion', payload })
    ).json<{ status: string; items: { contentReportsAnonymised: number } }>();
    expect(del).toMatchObject({ status: 'not_applicable', items: { contentReportsAnonymised: 1 } });
    // the audit chain is untouched by anonymisation
    expect(
      (await app.inject({ url: `/v1/audit-events/verify?tenantId=${INST}` })).json<{
        valid: boolean;
      }>().valid,
    ).toBe(true);
  });
});
