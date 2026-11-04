import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { InMemoryContentReportRepository } from './content-reports.js';
import { InMemoryAuditRepository } from './repository.js';

const INST = '11111111-1111-4111-8111-111111111111';
const STUDENT = '66666666-6666-4666-8666-666666666666';
const OTHER = '77777777-7777-4777-8777-777777777777';
const SECTION = '55555555-5555-4555-8555-555555555555';
const TOKEN = 'internal-secret';
const REQ = '99999999-9999-4999-8999-999999999999';

function setup() {
  const reports = new InMemoryContentReportRepository();
  const app = buildApp({
    repository: new InMemoryAuditRepository(),
    contentReports: reports,
    internalToken: TOKEN,
  });
  return { app, reports };
}

const dsr = (type: string, subjectId = STUDENT) => ({
  method: 'POST' as const,
  url: `/internal/v1/dsr/${type}`,
  headers: { 'x-internal-token': TOKEN },
  payload: { subjectType: 'student', subjectId, requestId: REQ, institutionId: INST },
});

describe('DSR handler (integration-stage §5)', () => {
  it('exports events where the subject is the actor, and their content reports', async () => {
    const { app } = setup();
    await app.inject({
      method: 'POST',
      url: '/v1/audit-events',
      payload: {
        tenantId: INST,
        actorId: STUDENT,
        actorType: 'student',
        action: 'lecture.viewed',
        resourceType: 'lecture',
        metadata: { classSectionId: SECTION },
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/audit-events',
      payload: {
        tenantId: INST,
        actorId: OTHER,
        actorType: 'student',
        action: 'lecture.viewed',
        resourceType: 'lecture',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/content-reports',
      payload: {
        reporterId: STUDENT,
        reporterRole: 'student',
        institutionId: INST,
        resourceType: 'calendar_event',
        resourceId: REQ,
        classSectionId: SECTION,
        reason: 'incorrect_date',
        details: 'Data errada',
      },
    });

    const res = await app.inject(dsr('access'));
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      service: string;
      status: string;
      items: { auditEvents: { action: string }[]; contentReports: unknown[] };
    }>();
    expect(body.service).toBe('audit');
    expect(body.status).toBe('completed');
    // lecture.viewed by the student + content.reported written on their behalf
    expect(body.items.auditEvents.map((e) => e.action).sort()).toEqual([
      'content.reported',
      'lecture.viewed',
    ]);
    expect(body.items.contentReports).toHaveLength(1);
  });

  it('keeps audit events on deletion (not_applicable with legal basis) and anonymises content reports', async () => {
    const { app, reports } = setup();
    await app.inject({
      method: 'POST',
      url: '/v1/content-reports',
      payload: {
        reporterId: STUDENT,
        reporterRole: 'student',
        institutionId: INST,
        resourceType: 'calendar_event',
        resourceId: REQ,
        classSectionId: SECTION,
        reason: 'other',
        details: 'texto livre',
      },
    });
    const res = (await app.inject(dsr('deletion'))).json<{
      status: string;
      items: {
        auditEvents: { retained: boolean; legalBasis: string };
        contentReportsAnonymised: number;
      };
    }>();
    expect(res.status).toBe('not_applicable');
    expect(res.items.auditEvents.retained).toBe(true);
    expect(res.items.auditEvents.legalBasis).toContain('LGPD');
    expect(res.items.contentReportsAnonymised).toBe(1);
    expect(await reports.byReporter(STUDENT)).toHaveLength(0);
    const after = (
      await app.inject({ url: `/v1/content-reports?classSectionId=${SECTION}` })
    ).json<{ items: { reporterId: string; details: string | null }[] }>();
    expect(after.items[0]).toMatchObject({
      reporterId: '00000000-0000-0000-0000-000000000000',
      details: null,
    });
    expect((await app.inject(dsr('restriction'))).json<{ status: string }>().status).toBe(
      'not_applicable',
    );
  });

  it('requires the internal token and validates input', async () => {
    const { app } = setup();
    const noToken = await app.inject({ ...dsr('access'), headers: {} });
    expect(noToken.statusCode).toBe(401);
    expect(noToken.json<{ error: { code: string } }>().error.code).toBe('internal_token_required');
    expect(
      (await app.inject({ ...dsr('access'), headers: { 'x-internal-token': 'wrong' } })).statusCode,
    ).toBe(401);
    expect((await app.inject(dsr('erase'))).statusCode).toBe(400);
    expect((await app.inject({ ...dsr('access'), payload: { subjectId: 'x' } })).statusCode).toBe(
      400,
    );
  });
});
