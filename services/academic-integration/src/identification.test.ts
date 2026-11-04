import { describe, expect, it } from 'vitest';
import type { ScheduledClass } from './domain.js';
import { identifyClass } from './identification.js';

function sc(id: string, startsAt: string, endsAt: string): ScheduledClass {
  return {
    id,
    institutionId: 'i',
    key: id,
    classSectionId: 's',
    courseId: 'c',
    professorId: 'p',
    classroomId: 'r',
    localDate: startsAt.slice(0, 10),
    timezone: 'UTC',
    startsAt,
    endsAt,
    status: 'scheduled',
    cancellationReason: null,
    source: 'timetable',
  };
}
const rec = (a: string, b: string) => ({ startedAt: new Date(a), endedAt: new Date(b) });

describe('identifyClass', () => {
  const morning = sc('a', '2026-11-04T14:00:00.000Z', '2026-11-04T15:30:00.000Z');
  const next = sc('b', '2026-11-04T15:30:00.000Z', '2026-11-04T17:00:00.000Z');

  it('matches a recording with pre/post roll to its class', () => {
    const r = identifyClass(rec('2026-11-04T13:50:00Z', '2026-11-04T15:40:00Z'), [morning, next]);
    expect(r.status).toBe('matched');
    expect(r.best?.scheduledClass.id).toBe('a');
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it('flags a recording spanning two back-to-back classes as ambiguous', () => {
    const r = identifyClass(rec('2026-11-04T14:00:00Z', '2026-11-04T17:00:00Z'), [morning, next]);
    expect(r.status).toBe('ambiguous');
    expect(r.alternatives).toHaveLength(1);
    expect(r.confidence).toBeLessThan(0.5);
  });

  it('returns unmatched when nothing overlaps', () => {
    const r = identifyClass(rec('2026-11-04T20:00:00Z', '2026-11-04T21:00:00Z'), [morning]);
    expect(r).toMatchObject({ status: 'unmatched', confidence: 0, best: null });
  });

  it('treats a short partial overlap as ambiguous', () => {
    const r = identifyClass(rec('2026-11-04T15:00:00Z', '2026-11-04T15:20:00Z'), [morning]);
    expect(r.status).toBe('ambiguous');
  });
});
