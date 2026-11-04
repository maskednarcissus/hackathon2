import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

interface Created {
  id: string;
  [k: string]: unknown;
}

let app: FastifyInstance;

async function post(
  url: string,
  payload: unknown,
): Promise<{ status: number; body: Created & { error?: { code: string } } }> {
  const res = await app.inject({
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
  });
  return { status: res.statusCode, body: res.json() };
}

async function seed(): Promise<{
  holdingId: string;
  institutionId: string;
  campusId: string;
  classroomId: string;
}> {
  const holding = await post('/v1/holding-companies', {
    name: 'Grupo Educa',
    legalName: 'Grupo Educa S.A.',
  });
  const inst = await post('/v1/institutions', {
    holdingCompanyId: holding.body.id,
    name: 'Universidade Alfa',
    state: 'SP',
  });
  const campus = await post('/v1/campuses', {
    institutionId: inst.body.id,
    name: 'Campus Paulista',
    city: 'São Paulo',
    state: 'SP',
  });
  const room = await post('/v1/classrooms', {
    campusId: campus.body.id,
    name: 'Sala 101',
    code: 'A-101',
    capacity: 60,
  });
  return {
    holdingId: holding.body.id,
    institutionId: inst.body.id,
    campusId: campus.body.id,
    classroomId: room.body.id,
  };
}

beforeEach(() => {
  app = buildApp();
});

describe('organization hierarchy', () => {
  it('creates the full hierarchy and returns a tree', async () => {
    const ids = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/institutions/${ids.institutionId}/tree`,
    });
    expect(res.statusCode).toBe(200);
    const tree = res.json<{
      campuses: { id: string; timezone: string; classrooms: { code: string }[] }[];
    }>();
    expect(tree.campuses).toHaveLength(1);
    expect(tree.campuses[0]?.timezone).toBe('America/Sao_Paulo');
    expect(tree.campuses[0]?.classrooms.map((c) => c.code)).toEqual(['A-101']);
  });

  it('exposes tenant and timezone on classroom lookup', async () => {
    const ids = await seed();
    const res = await app.inject({ method: 'GET', url: `/v1/classrooms/${ids.classroomId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: ids.classroomId,
      campusId: ids.campusId,
      institutionId: ids.institutionId,
      timezone: 'America/Sao_Paulo',
    });
  });

  it('rejects children with unknown parents', async () => {
    const res = await post('/v1/campuses', {
      institutionId: '00000000-0000-4000-8000-000000000000',
      name: 'X',
      city: 'Y',
      state: 'SP',
    });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('not_found');
  });

  it('enforces unique classroom codes per campus but allows them across campuses', async () => {
    const ids = await seed();
    const dup = await post('/v1/classrooms', {
      campusId: ids.campusId,
      name: 'Outra',
      code: 'a-101',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.code).toBe('duplicate_code');
    const campus2 = await post('/v1/campuses', {
      institutionId: ids.institutionId,
      name: 'Campus Centro',
      city: 'São Paulo',
      state: 'SP',
    });
    const ok = await post('/v1/classrooms', {
      campusId: campus2.body.id,
      name: 'Sala 101',
      code: 'A-101',
    });
    expect(ok.status).toBe(201);
  });

  it('rejects invalid timezones and payloads', async () => {
    const ids = await seed();
    const res = await post('/v1/campuses', {
      institutionId: ids.institutionId,
      name: 'Z',
      city: 'Z',
      state: 'SP',
      timezone: 'Mars/Olympus',
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('validation_error');
  });

  it('prevents deleting a parent that still has children', async () => {
    const ids = await seed();
    const res = await app.inject({ method: 'DELETE', url: `/v1/campuses/${ids.campusId}` });
    expect(res.statusCode).toBe(409);
    const delRoom = await app.inject({
      method: 'DELETE',
      url: `/v1/classrooms/${ids.classroomId}`,
    });
    expect(delRoom.statusCode).toBe(204);
    const delCampus = await app.inject({ method: 'DELETE', url: `/v1/campuses/${ids.campusId}` });
    expect(delCampus.statusCode).toBe(204);
  });

  it('updates a classroom with PATCH', async () => {
    const ids = await seed();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/classrooms/${ids.classroomId}`,
      payload: { capacity: 80 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ capacity: 80, code: 'A-101' });
  });
});

describe('recording policies', () => {
  const policy = {
    name: 'Padrão',
    legalBasis: 'legitimate_interest',
    preRollMinutes: 3,
    postRollMinutes: 10,
  };

  it('returns 404 no_recording_policy when nothing applies', async () => {
    const ids = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/classrooms/${ids.classroomId}/recording-policy`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('no_recording_policy');
  });

  it('resolves classroom > campus > institution default', async () => {
    const ids = await seed();
    const def = await post(`/v1/institutions/${ids.institutionId}/recording-policies`, policy);
    expect(def.status).toBe(201);
    expect(def.body['isDefault']).toBe(true);
    expect(def.body['audioRetentionDays']).toBe(90);

    const get = async (): Promise<{ source: string; policy: { id: string } }> =>
      (
        await app.inject({
          method: 'GET',
          url: `/v1/classrooms/${ids.classroomId}/recording-policy`,
        })
      ).json();

    expect(await get()).toMatchObject({
      source: 'institution_default',
      policy: { id: def.body.id },
    });

    const campusPolicy = await post(`/v1/institutions/${ids.institutionId}/recording-policies`, {
      ...policy,
      name: 'Campus',
    });
    await app.inject({
      method: 'PATCH',
      url: `/v1/campuses/${ids.campusId}`,
      payload: { recordingPolicyId: campusPolicy.body.id },
    });
    expect(await get()).toMatchObject({ source: 'campus', policy: { id: campusPolicy.body.id } });

    const roomPolicy = await post(`/v1/institutions/${ids.institutionId}/recording-policies`, {
      ...policy,
      name: 'Sem gravação',
      recordingEnabled: false,
    });
    await app.inject({
      method: 'PATCH',
      url: `/v1/classrooms/${ids.classroomId}`,
      payload: { recordingPolicyId: roomPolicy.body.id },
    });
    expect(await get()).toMatchObject({ source: 'classroom', policy: { recordingEnabled: false } });

    await app.inject({
      method: 'PATCH',
      url: `/v1/classrooms/${ids.classroomId}`,
      payload: { recordingPolicyId: null },
    });
    expect(await get()).toMatchObject({ source: 'campus' });
  });

  it('keeps a single default policy per institution', async () => {
    const ids = await seed();
    const a = await post(`/v1/institutions/${ids.institutionId}/recording-policies`, policy);
    const b = await post(`/v1/institutions/${ids.institutionId}/recording-policies`, {
      ...policy,
      name: 'B',
      isDefault: true,
    });
    const list = (
      await app.inject({
        method: 'GET',
        url: `/v1/institutions/${ids.institutionId}/recording-policies`,
      })
    ).json<{
      items: { id: string; isDefault: boolean }[];
    }>();
    expect(list.items.filter((p) => p.isDefault).map((p) => p.id)).toEqual([b.body.id]);
    expect(list.items.find((p) => p.id === a.body.id)?.isDefault).toBe(false);
  });

  it('rejects a policy from another institution (tenant isolation)', async () => {
    const ids = await seed();
    const other = await post('/v1/institutions', {
      holdingCompanyId: ids.holdingId,
      name: 'Faculdade Beta',
      state: 'RJ',
    });
    const foreign = await post(`/v1/institutions/${other.body.id}/recording-policies`, policy);
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/classrooms/${ids.classroomId}`,
      payload: { recordingPolicyId: foreign.body.id },
    });
    expect(res.statusCode).toBe(422);
  });
});
