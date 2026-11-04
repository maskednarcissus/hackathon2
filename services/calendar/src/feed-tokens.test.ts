import { describe, expect, it } from 'vitest';
import { redactTokens } from './app.js';
import { generateFeedToken, verifyFeedToken } from './feed-tokens.js';

describe('feed tokens', () => {
  it('stores only a hash and verifies in constant time', () => {
    const { token, tokenHash } = generateFeedToken();
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token);
    expect(verifyFeedToken(token, tokenHash)).toBe(true);
    expect(verifyFeedToken(`${token}x`, tokenHash)).toBe(false);
    expect(verifyFeedToken('', tokenHash)).toBe(false);
  });

  it('generates distinct tokens', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateFeedToken().token));
    expect(seen.size).toBe(100);
  });

  it('redacts tokens from logged URLs', () => {
    expect(redactTokens('/v1/students/x/calendar.ics?token=cft_secret&from=2026-01-01')).toBe(
      '/v1/students/x/calendar.ics?token=[REDACTED]&from=2026-01-01',
    );
  });
});
