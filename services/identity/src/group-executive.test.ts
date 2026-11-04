import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeJwt } from './jwt-verify.js';
import { InMemoryInstitutionDirectory } from './repositories.js';
import {
  bearer,
  INSTITUTION_A,
  INSTITUTION_B,
  INTERNAL_TOKEN,
  login,
  setup,
  type TestContext,
} from './test/helpers.js';

const HOLDING = randomUUID();
const OTHER_HOLDING = randomUUID();
let ctx: TestContext;
type Json = Record<string, unknown>;

beforeEach(async () => {
  const institutions = new InMemoryInstitutionDirectory();
  institutions.set(INSTITUTION_A, HOLDING);
  institutions.set(INSTITUTION_B, OTHER_HOLDING);
  ctx = await setup({ institutions });
});
afterEach(async () => {
  await ctx.app.close();
});

const executive = (overrides: Json = {}): Json => ({
  institutionId: INSTITUTION_A,
  email: `ceo-${randomUUID().slice(0, 6)}@grupo.example`,
  name: 'Diretora do Grupo',
  role: 'group_executive',
  holdingCompanyId: HOLDING,
  password: 'senha-executiva-longa',
  ...overrides,
});

const create = (payload: Json, headers: Record<string, string>) =>
  ctx.app.inject({ method: 'POST', url: '/v1/users', headers, payload });

describe('group_executive (Phase 5 §2)', () => {
  it('is created by an admin of an institution of the holding; token carries hc; /v1/me returns it', async () => {
    const admin = await login(ctx, ctx.users.admin);
    const body = executive();
    const res = await create(body, bearer(admin.accessToken));
    expect(res.statusCode).toBe(201);
    expect(res.json<Json>()).toMatchObject({ role: 'group_executive', holdingCompanyId: HOLDING });

    const session = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: body['email'], password: body['password'], institutionId: INSTITUTION_A },
    });
    const { accessToken } = session.json<{ accessToken: string }>();
    const { payload } = decodeJwt(accessToken);
    expect(payload).toMatchObject({ role: 'group_executive', hc: HOLDING, inst: INSTITUTION_A });
    expect(payload['pid']).toBeUndefined();
    const me = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(accessToken) });
    expect(me.json<Json>()['holdingCompanyId']).toBe(HOLDING);
  });

  it('other roles get no hc claim and holdingCompanyId null', async () => {
    const coordinator = await login(ctx, ctx.users.coordinator);
    expect(decodeJwt(coordinator.accessToken).payload['hc']).toBeUndefined();
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(coordinator.accessToken),
    });
    expect(me.json<Json>()['holdingCompanyId']).toBeNull();
  });

  it('rejects a holding company the institution does not belong to', async () => {
    const admin = await login(ctx, ctx.users.admin);
    const res = await create(
      executive({ holdingCompanyId: OTHER_HOLDING }),
      bearer(admin.accessToken),
    );
    expect(res.statusCode).toBe(403);
    expect((res.json<Json>()['error'] as Json)['code']).toBe('holding_company_mismatch');
  });

  it('validates holdingCompanyId presence per role', async () => {
    const admin = await login(ctx, ctx.users.admin);
    expect(
      (await create(executive({ holdingCompanyId: undefined }), bearer(admin.accessToken)))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await create(
          { ...executive(), role: 'coordinator', holdingCompanyId: HOLDING },
          bearer(admin.accessToken),
        )
      ).statusCode,
    ).toBe(400);
  });

  it('may be provisioned with the internal token; only admins otherwise', async () => {
    const internal = { 'x-internal-token': INTERNAL_TOKEN };
    expect((await create(executive(), internal)).statusCode).toBe(201);
    expect((await create(executive({ institutionId: INSTITUTION_B }), internal)).statusCode).toBe(
      403,
    );
    expect(
      (
        await create(
          executive({ institutionId: INSTITUTION_B, holdingCompanyId: OTHER_HOLDING }),
          internal,
        )
      ).statusCode,
    ).toBe(201);
    const coordinator = await login(ctx, ctx.users.coordinator);
    expect((await create(executive(), bearer(coordinator.accessToken))).statusCode).toBe(403);
    expect((await create(executive(), {})).statusCode).toBe(401);
  });

  it('is denied every per-institution resource by /v1/authorize and has no sections', async () => {
    const internal = { 'x-internal-token': INTERNAL_TOKEN };
    const created = (await create(executive(), internal)).json<{ id: string; email: string }>();
    for (const type of [
      'class_section',
      'lecture',
      'transcript',
      'calendar_event',
      'scheduled_class',
    ]) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/v1/authorize',
        headers: internal,
        payload: {
          subject: created.id,
          action: 'read',
          resource: { type, classSectionId: ctx.sections.a1 },
        },
      });
      expect(res.json()).toEqual({ allowed: false, reason: 'group_scope_only' });
    }
    const session = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: created.email,
        password: 'senha-executiva-longa',
        institutionId: INSTITUTION_A,
      },
    });
    const sections = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me/sections',
      headers: bearer(session.json<{ accessToken: string }>().accessToken),
    });
    expect(sections.json<Json>()['classSectionIds']).toEqual([]);
  });
});
