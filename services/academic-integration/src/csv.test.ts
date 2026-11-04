import { describe, expect, it } from 'vitest';
import { parseCsv, parseDayOfWeek, timetableCsvToPayload } from './csv.js';

describe('csv', () => {
  it('parses quoted fields, escaped quotes and semicolon delimiters', () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""oi"""\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "oi"'],
    ]);
    expect(parseCsv('﻿a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('understands Portuguese day names', () => {
    expect(parseDayOfWeek('Segunda-feira')).toBe(1);
    expect(parseDayOfWeek('sábado')).toBe(6);
    expect(parseDayOfWeek('3')).toBe(3);
    expect(parseDayOfWeek('funday')).toBeNull();
  });

  it('reports row-level errors and missing columns', () => {
    expect(
      timetableCsvToPayload('a,b\n1,2', '11111111-1111-4111-8111-111111111111', undefined).errors[0]
        ?.code,
    ).toBe('missing_columns');
  });
});
