import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { HttpRetentionTarget, HttpRosterClient } from './clients.js';

describe('scheduler & internal auth (§4)', () => {
  const app = buildApp({ internalToken: 'int', adminToken: 'adm' });
  const run = (headers: Record<string, string>): Promise<LightMyRequestResponse> =>
    app.inject({
      method: 'POST',
      url: '/v1/retention/run',
      headers,
      payload: { institutionId: '11111111-1111-4111-8111-111111111111', dryRun: true },
    });

  it('requires the internal token (scheduler) or the admin bearer (console)', async () => {
    expect((await run({})).statusCode).toBe(401);
    expect((await run({ 'x-internal-token': 'nope' })).statusCode).toBe(401);
    // Authenticated requests reach the handler (404: unknown institution).
    expect((await run({ 'x-internal-token': 'int' })).statusCode).toBe(404);
    expect((await run({ authorization: 'Bearer adm' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/internal/v1/anything' })).statusCode).toBe(
      401,
    );
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});

describe('data-owner clients send x-internal-token (§5)', () => {
  let owner: FastifyInstance;
  let base: string;
  const seen: { url: string; token: unknown; body: unknown }[] = [];

  beforeAll(async () => {
    owner = Fastify();
    owner.get('/internal/v1/retention/candidates', (req) => {
      seen.push({ url: req.url, token: req.headers['x-internal-token'], body: null });
      return { candidates: [{ id: 'r1', createdAt: '2026-01-01T00:00:00.000Z' }] };
    });
    owner.post('/internal/v1/retention/delete', (req) => {
      seen.push({ url: req.url, token: req.headers['x-internal-token'], body: req.body });
      return { deletedIds: ['r1'] };
    });
    owner.get('/v1/class-sections/:id/roster', (req) => {
      seen.push({ url: req.url, token: req.headers['x-internal-token'], body: null });
      return { classSectionId: 's', institutionId: 'i', professorIds: [], studentIds: [] };
    });
    base = await owner.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await owner.close();
  });

  it('calls candidates/delete/roster with the token', async () => {
    const target = new HttpRetentionTarget('audio-ingestion', base, ['audio'], 5000, 'int');
    const candidates = await target.candidates({
      institutionId: 'i',
      olderThan: '2026-02-01T00:00:00.000Z',
      kind: 'audio',
    });
    expect(candidates).toEqual([{ id: 'r1', createdAt: '2026-01-01T00:00:00.000Z' }]);
    expect(await target.delete({ ids: ['r1'], kind: 'audio', jobId: 'j' })).toEqual(['r1']);
    await new HttpRosterClient(base, 5000, 'int').getRoster('s');
    expect(seen.map((s) => s.token)).toEqual(['int', 'int', 'int']);
    expect(seen[0]?.url).toContain('kind=audio');
    expect(seen[1]?.body).toEqual({ ids: ['r1'], kind: 'audio', jobId: 'j' });
  });
});
