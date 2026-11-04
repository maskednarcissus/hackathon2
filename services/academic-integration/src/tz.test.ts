import { describe, expect, it } from 'vitest';
import { eachDate, isValidTimeZone, localDate, zonedTimeToUtc } from './tz.js';

describe('zonedTimeToUtc', () => {
  it('converts São Paulo (UTC−3, no DST since 2019)', () => {
    expect(zonedTimeToUtc('2026-11-04', '19:00', 'America/Sao_Paulo').toISOString()).toBe(
      '2026-11-04T22:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-01-15', '08:30', 'America/Sao_Paulo').toISOString()).toBe(
      '2026-01-15T11:30:00.000Z',
    );
  });

  it('handles historic Brazilian DST (2018-11-04 started at 00:00 → 01:00)', () => {
    expect(zonedTimeToUtc('2018-12-10', '19:00', 'America/Sao_Paulo').toISOString()).toBe(
      '2018-12-10T21:00:00.000Z',
    );
    // 00:30 did not exist on 2018-11-04
    expect(zonedTimeToUtc('2018-11-04', '00:30', 'America/Sao_Paulo').toISOString()).toBe(
      '2018-11-04T03:30:00.000Z',
    );
  });

  it('converts across New York DST transitions', () => {
    expect(zonedTimeToUtc('2026-10-26', '19:00', 'America/New_York').toISOString()).toBe(
      '2026-10-26T23:00:00.000Z',
    );
    expect(zonedTimeToUtc('2026-11-02', '19:00', 'America/New_York').toISOString()).toBe(
      '2026-11-03T00:00:00.000Z',
    );
    // ambiguous 01:30 on fall-back day → first occurrence (EDT)
    expect(zonedTimeToUtc('2026-11-01', '01:30', 'America/New_York').toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    // 02:30 does not exist on spring-forward day → shifted past the gap (03:30 EDT)
    expect(zonedTimeToUtc('2026-03-08', '02:30', 'America/New_York').toISOString()).toBe(
      '2026-03-08T07:30:00.000Z',
    );
  });

  it('derives local dates and iterates calendars', () => {
    expect(localDate(new Date('2026-11-05T01:00:00Z'), 'America/Sao_Paulo')).toBe('2026-11-04');
    const days = [...eachDate('2026-11-01', '2026-11-03')];
    expect(days).toEqual([
      { date: '2026-11-01', dayOfWeek: 0 },
      { date: '2026-11-02', dayOfWeek: 1 },
      { date: '2026-11-03', dayOfWeek: 2 },
    ]);
    expect(isValidTimeZone('America/Sao_Paulo')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
