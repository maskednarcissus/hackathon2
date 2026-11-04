import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { InMemoryAuditClient } from './audit.js';
import type { CalendarEvent, CalendarEventChange, Conflict } from './domain.js';

const INSTITUTION = randomUUID();
const COURSE_A = randomUUID();
const COURSE_B = randomUUID();
const SECTION_A = randomUUID();
const SECTION_B = randomUUID();
const PROFESSOR = randomUUID();
const STUDENTS = Array.from({ length: 4 }, () => randomUUID());

interface PublishBody {
  event: CalendarEvent;
  created: boolean;
  changes: CalendarEventChange[];
  conflicts: Conflict[];
}

const provenance = (
  quote = 'nossa segunda prova será no dia 20 de novembro',
): Record<string, unknown> => ({
  recordingSessionId: randomUUID(),
  transcriptId: randomUUID(),
  segmentIndex: 42,
  startMs: 2_461_000,
  endMs: 2_468_500,
  quote,
  confirmedBy: PROFESSOR,
  confirmedAt: '2026-11-04T22:00:00.000Z',
});

const fixedClock = { now: (): Date => new Date('2026-11-04T22:30:00.000Z') };

describe('calendar service', () => {
  let app: FastifyInstance;
  let audit: InMemoryAuditClient;

  const publish = async (
    overrides: Record<string, unknown> = {},
  ): Promise<LightMyRequestResponse> =>
    app.inject({
      method: 'POST',
      url: '/v1/calendar-events',
      payload: {
        institutionId: INSTITUTION,
        courseId: COURSE_A,
        classSectionId: SECTION_A,
        type: 'examination',
        title: 'Prova 2',
        eventDate: '2026-11-20',
        eventTime: '19:00',
        changedBy: PROFESSOR,
        ...overrides,
      },
    });

  beforeEach(async (): Promise<void> => {
    audit = new InMemoryAuditClient();
    app = buildApp({ audit, clock: fixedClock });
    await app.inject({
      method: 'POST',
      url: '/v1/sections',
      payload: {
        sections: [
          { classSectionId: SECTION_A, institutionId: INSTITUTION, courseId: COURSE_A },
          { classSectionId: SECTION_B, institutionId: INSTITUTION, courseId: COURSE_B },
        ],
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/enrollments/bulk',
      payload: { classSectionId: SECTION_A, studentIds: STUDENTS },
    });
    // Two students shared with section B
    await app.inject({
      method: 'POST',
      url: '/v1/enrollments/bulk',
      payload: { classSectionId: SECTION_B, studentIds: [STUDENTS[0], STUDENTS[1], randomUUID()] },
    });
  });

  it('publishes an event with provenance and records audit', async () => {
    const extractedEventId = randomUUID();
    const res = await publish({ extractedEventId, provenance: provenance() });
    expect(res.statusCode).toBe(201);
    const body = res.json<PublishBody>();
    expect(body.created).toBe(true);
    expect(body.event.provenance?.segmentIndex).toBe(42);
    expect(body.event.version).toBe(1);
    expect(audit.events.map((e) => e.action)).toEqual(['calendar.event_published']);
  });

  it('requires provenance for events coming from extraction', async () => {
    const res = await publish({ extractedEventId: randomUUID() });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('validation_error');
  });

  it('rejects invalid dates and unknown timezones', async () => {
    expect((await publish({ eventDate: '2026-02-30' })).statusCode).toBe(400);
    expect((await publish({ timezone: 'Mars/Olympus' })).statusCode).toBe(400);
  });

  it('upserts by extractedEventId and records a date_change instead of overwriting', async () => {
    const extractedEventId = randomUUID();
    const first = (
      await publish({ extractedEventId, provenance: provenance() })
    ).json<PublishBody>();
    const res = await publish({
      extractedEventId,
      provenance: provenance('a prova fica para o dia 27'),
      eventDate: '2026-11-27',
      changeReason: 'Professor adiou a prova',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<PublishBody>();
    expect(body.event.id).toBe(first.event.id);
    expect(body.event.version).toBe(2);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({
      changeType: 'date_change',
      field: 'eventDate',
      previousValue: '2026-11-20',
      newValue: '2026-11-27',
      reason: 'Professor adiou a prova',
    });

    const detail = await app.inject({ url: `/v1/calendar-events/${first.event.id}` });
    expect(detail.json<{ history: CalendarEventChange[] }>().history).toHaveLength(1);
    expect(audit.events.map((e) => e.action)).toEqual([
      'calendar.event_published',
      'calendar.event_updated',
    ]);
  });

  it('is idempotent when republishing identical content', async () => {
    const extractedEventId = randomUUID();
    const p = provenance();
    await publish({ extractedEventId, provenance: p });
    const again = (await publish({ extractedEventId, provenance: p })).json<PublishBody>();
    expect(again.changes).toHaveLength(0);
    expect(again.event.version).toBe(1);
    expect(audit.events).toHaveLength(1);
  });

  it('refuses to move an extracted event to another section', async () => {
    const extractedEventId = randomUUID();
    await publish({ extractedEventId, provenance: provenance() });
    const res = await publish({
      extractedEventId,
      provenance: provenance(),
      classSectionId: SECTION_B,
      courseId: COURSE_B,
    });
    expect(res.statusCode).toBe(409);
  });

  it('cancels with a cancellation change record', async () => {
    const id = (await publish()).json<PublishBody>().event.id;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calendar-events/${id}/cancel`,
      payload: { actorId: PROFESSOR, reason: 'Prova substituída por trabalho' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ event: CalendarEvent }>().event.status).toBe('cancelled');
    const history = await app.inject({ url: `/v1/calendar-events/${id}/history` });
    expect(history.json<{ items: CalendarEventChange[] }>().items[0]?.changeType).toBe(
      'cancellation',
    );
    const list = await app.inject({ url: `/v1/calendar-events?classSectionId=${SECTION_A}` });
    expect(list.json<{ total: number }>().total).toBe(0);
    const withCancelled = await app.inject({
      url: `/v1/calendar-events?classSectionId=${SECTION_A}&includeCancelled=true`,
    });
    expect(withCancelled.json<{ total: number }>().total).toBe(1);
  });

  describe('conflict detection', () => {
    const check = async (
      payload: Record<string, unknown>,
    ): Promise<{ conflicts: Conflict[]; hasBlocking: boolean }> =>
      (
        await app.inject({
          method: 'POST',
          url: '/v1/conflicts/check',
          payload: { institutionId: INSTITUTION, classSectionId: SECTION_A, ...payload },
        })
      ).json<{ conflicts: Conflict[]; hasBlocking: boolean }>();

    it('returns no conflicts on an empty calendar', async () => {
      const r = await check({ type: 'examination', eventDate: '2026-11-20' });
      expect(r.conflicts).toEqual([]);
      expect(r.hasBlocking).toBe(false);
    });

    it('detects same_section_same_day (blocking when same time)', async () => {
      await publish({ type: 'quiz', title: 'Quiz 3' });
      const r = await check({ type: 'examination', eventDate: '2026-11-20', eventTime: '19:00' });
      const c = r.conflicts.find((x) => x.kind === 'same_section_same_day');
      expect(c?.severity).toBe('blocking');
      const other = await check({ type: 'assignment', eventDate: '2026-11-20' });
      expect(other.conflicts.find((x) => x.kind === 'same_section_same_day')?.severity).toBe(
        'warning',
      );
    });

    it('detects existing_event_different_date for the same type', async () => {
      const id = (await publish()).json<PublishBody>().event.id;
      const r = await check({ type: 'examination', eventDate: '2026-11-27' });
      const c = r.conflicts.find((x) => x.kind === 'existing_event_different_date');
      expect(c?.relatedEventId).toBe(id);
    });

    it('excludes the event itself', async () => {
      const id = (await publish()).json<PublishBody>().event.id;
      const r = await check({ type: 'examination', eventDate: '2026-11-20', excludeEventId: id });
      expect(r.conflicts).toEqual([]);
    });

    it('detects assessment_overlap_shared_students without exposing identities', async () => {
      await publish({ classSectionId: SECTION_B, courseId: COURSE_B, title: 'Prova de Cálculo' });
      const r = await check({ type: 'examination', eventDate: '2026-11-20' });
      const c = r.conflicts.find((x) => x.kind === 'assessment_overlap_shared_students');
      expect(c?.message).toContain('2 aluno(s)');
      for (const s of STUDENTS) expect(c?.message).not.toContain(s);
    });

    it('detects assessment_load (>= 3 assessments in 7 days)', async () => {
      await publish({ classSectionId: SECTION_B, courseId: COURSE_B, eventDate: '2026-11-16' });
      await publish({ type: 'assignment', title: 'Trabalho 1', eventDate: '2026-11-18' });
      const r = await check({ type: 'examination', eventDate: '2026-11-21' });
      const c = r.conflicts.find((x) => x.kind === 'assessment_load');
      expect(c).toBeDefined();
      // only the 2 shared students have 3; the other 2 have 2
      expect(c?.message).toContain('2 aluno(s)');
      const far = await check({ type: 'examination', eventDate: '2026-11-30' });
      expect(far.conflicts.find((x) => x.kind === 'assessment_load')).toBeUndefined();
    });

    it('flags non-teaching days and dates outside the term', async () => {
      await app.inject({
        method: 'POST',
        url: '/v1/non-teaching-days',
        payload: {
          institutionId: INSTITUTION,
          days: [{ date: '2026-11-20', description: 'Dia da Consciência Negra' }],
        },
      });
      await app.inject({
        method: 'POST',
        url: '/v1/terms',
        payload: { institutionId: INSTITUTION, startDate: '2026-08-01', endDate: '2026-12-15' },
      });
      const holiday = await check({ type: 'examination', eventDate: '2026-11-20' });
      expect(holiday.hasBlocking).toBe(true);
      expect(holiday.conflicts[0]?.kind).toBe('non_teaching_day');
      const deadline = await check({ type: 'reading_deadline', eventDate: '2026-11-20' });
      expect(deadline.conflicts[0]?.severity).toBe('warning');
      const outside = await check({ type: 'quiz', eventDate: '2027-01-10' });
      expect(outside.conflicts[0]?.message).toContain('fora do período letivo');
    });

    it('returns conflicts alongside a publish', async () => {
      await publish({ classSectionId: SECTION_B, courseId: COURSE_B });
      const body = (await publish()).json<PublishBody>();
      expect(body.conflicts.map((c) => c.kind)).toContain('assessment_overlap_shared_students');
    });
  });

  it('serves a student calendar from enrolled sections only', async () => {
    await publish();
    await publish({ classSectionId: SECTION_B, courseId: COURSE_B, title: 'Prova B' });
    const lonely = STUDENTS[3] ?? '';
    const shared = STUDENTS[0] ?? '';
    const a = await app.inject({ url: `/v1/students/${lonely}/calendar-events` });
    expect(a.json<{ items: CalendarEvent[] }>().items.map((e) => e.title)).toEqual(['Prova 2']);
    const b = await app.inject({ url: `/v1/students/${shared}/calendar-events` });
    expect(b.json<{ total: number }>().total).toBe(2);
    const none = await app.inject({ url: `/v1/students/${randomUUID()}/calendar-events` });
    expect(none.json<{ total: number }>().total).toBe(0);
  });

  it('rejects enrollment sync for unknown sections and validates ids', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enrollments/bulk',
      payload: { classSectionId: randomUUID(), studentIds: [] },
    });
    expect(res.statusCode).toBe(404);
    const bad = await app.inject({ url: '/v1/calendar-events/not-a-uuid' });
    expect(bad.statusCode).toBe(400);
  });
});
