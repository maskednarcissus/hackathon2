import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bearer,
  INSTITUTION_A,
  INSTITUTION_B,
  INTERNAL_TOKEN,
  login,
  setup,
  type TestContext,
} from './test/helpers.js';

let ctx: TestContext;
const internal = { 'x-internal-token': INTERNAL_TOKEN };

beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
});

const authorize = (
  subject: unknown,
  classSectionId: string,
  headers: Record<string, string> = internal,
  type = 'class_section',
) =>
  ctx.app.inject({
    method: 'POST',
    url: '/v1/authorize',
    headers,
    payload: { subject, action: 'read', resource: { type, classSectionId } },
  });

describe('POST /v1/authorize', () => {
  it('allows an enrolled student, by token and by user id', async () => {
    const { accessToken } = await login(ctx, ctx.users.student);
    for (const subject of [
      accessToken,
      { token: accessToken },
      ctx.users.student.id,
      { userId: ctx.users.student.id },
    ]) {
      const res = await authorize(subject, ctx.sections.a1);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ allowed: true, reason: 'enrolled' });
    }
  });

  it('applies to every resource type through the class section', async () => {
    for (const type of ['scheduled_class', 'transcript', 'lecture', 'calendar_event']) {
      const res = await authorize(ctx.users.student.id, ctx.sections.a1, internal, type);
      expect(res.json()).toEqual({ allowed: true, reason: 'enrolled' });
    }
  });

  it('denies a student who is not enrolled', async () => {
    const res = await authorize(ctx.users.student.id, ctx.sections.a2);
    expect(res.json()).toEqual({ allowed: false, reason: 'not_enrolled' });
  });

  it('denies a withdrawn enrollment (replace sync)', async () => {
    const sync = await ctx.app.inject({
      method: 'POST',
      url: '/v1/sync/enrollments',
      headers: internal,
      payload: {
        institutionId: INSTITUTION_A,
        mode: 'replace',
        enrollments: [
          { studentId: ctx.users.otherStudent.studentId, classSectionId: ctx.sections.a1 },
        ],
      },
    });
    expect(sync.json()).toEqual({ upserted: 1, rejected: 0, withdrawn: 1 });
    expect((await authorize(ctx.users.student.id, ctx.sections.a1)).json()).toEqual({
      allowed: false,
      reason: 'enrollment_inactive',
    });
    expect((await authorize(ctx.users.otherStudent.id, ctx.sections.a1)).json()).toEqual({
      allowed: true,
      reason: 'enrolled',
    });
  });

  it('denies an explicitly withdrawn enrollment', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/sync/enrollments',
      headers: internal,
      payload: {
        institutionId: INSTITUTION_A,
        enrollments: [
          {
            studentId: ctx.users.student.studentId,
            classSectionId: ctx.sections.a1,
            status: 'withdrawn',
          },
        ],
      },
    });
    expect((await authorize(ctx.users.student.id, ctx.sections.a1)).json()).toEqual({
      allowed: false,
      reason: 'enrollment_inactive',
    });
  });

  it('allows the professor who teaches the section only', async () => {
    expect((await authorize(ctx.users.professor.id, ctx.sections.a1)).json()).toEqual({
      allowed: true,
      reason: 'teaches_section',
    });
    expect((await authorize(ctx.users.professor.id, ctx.sections.a2)).json()).toEqual({
      allowed: false,
      reason: 'not_teaching',
    });
  });

  it('allows coordinators and admins within their institution', async () => {
    expect((await authorize(ctx.users.coordinator.id, ctx.sections.a2)).json()).toEqual({
      allowed: true,
      reason: 'institution_staff',
    });
    expect((await authorize(ctx.users.admin.id, ctx.sections.a1)).json()).toEqual({
      allowed: true,
      reason: 'institution_staff',
    });
  });

  it('always denies cross-institution access, including for admins', async () => {
    expect((await authorize(ctx.users.admin.id, ctx.sections.b1)).json()).toEqual({
      allowed: false,
      reason: 'cross_institution',
    });
    expect((await authorize(ctx.users.adminB.id, ctx.sections.a1)).json()).toEqual({
      allowed: false,
      reason: 'cross_institution',
    });
    // A student "enrolled" in another tenant's section via a forged sync is still denied.
    await ctx.deps.repos.access.upsertEnrollment({
      institutionId: INSTITUTION_A,
      studentId: ctx.users.student.studentId ?? '',
      classSectionId: ctx.sections.b1,
      status: 'active',
      syncedAt: ctx.clock.now(),
    });
    expect((await authorize(ctx.users.student.id, ctx.sections.b1)).json()).toEqual({
      allowed: false,
      reason: 'cross_institution',
    });
  });

  it('denies unknown sections, disabled users and invalid tokens', async () => {
    expect((await authorize(ctx.users.student.id, randomUUID())).json()).toEqual({
      allowed: false,
      reason: 'section_unknown',
    });
    await ctx.deps.repos.users.update({ ...ctx.users.student, status: 'disabled' });
    expect((await authorize(ctx.users.student.id, ctx.sections.a1)).json()).toEqual({
      allowed: false,
      reason: 'user_inactive',
    });
    expect((await authorize('a.b.c', ctx.sections.a1)).json()).toEqual({
      allowed: false,
      reason: 'invalid_token',
    });
    expect((await authorize(randomUUID(), ctx.sections.a1)).json()).toEqual({
      allowed: false,
      reason: 'user_unknown',
    });
  });

  it('requires an internal token or a bearer token', async () => {
    expect((await authorize(ctx.users.student.id, ctx.sections.a1, {})).statusCode).toBe(401);
    expect(
      (await authorize(ctx.users.student.id, ctx.sections.a1, { 'x-internal-token': 'wrong' }))
        .statusCode,
    ).toBe(401);
  });

  it('a student bearer may only ask about itself', async () => {
    const { accessToken } = await login(ctx, ctx.users.student);
    expect(
      (await authorize(ctx.users.student.id, ctx.sections.a1, bearer(accessToken))).json(),
    ).toEqual({
      allowed: true,
      reason: 'enrolled',
    });
    expect(
      (await authorize(ctx.users.otherStudent.id, ctx.sections.a1, bearer(accessToken))).statusCode,
    ).toBe(403);
  });

  it('a coordinator bearer may ask about users of its own institution only', async () => {
    const { accessToken } = await login(ctx, ctx.users.coordinator);
    expect(
      (await authorize(ctx.users.student.id, ctx.sections.a1, bearer(accessToken))).statusCode,
    ).toBe(200);
    expect(
      (await authorize(ctx.users.adminB.id, ctx.sections.b1, bearer(accessToken))).statusCode,
    ).toBe(403);
  });
});

describe('GET /v1/me/sections', () => {
  it('lists active enrollments for students', async () => {
    const { accessToken } = await login(ctx, ctx.users.student);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me/sections',
      headers: bearer(accessToken),
    });
    expect(res.json()).toEqual({
      role: 'student',
      institutionId: INSTITUTION_A,
      classSectionIds: [ctx.sections.a1],
    });
  });

  it('lists taught sections for professors and institution sections for staff', async () => {
    const prof = await login(ctx, ctx.users.professor);
    const profRes = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me/sections',
      headers: bearer(prof.accessToken),
    });
    expect(profRes.json<{ classSectionIds: string[] }>().classSectionIds).toEqual([
      ctx.sections.a1,
    ]);

    const coord = await login(ctx, ctx.users.coordinator);
    const coordRes = await ctx.app.inject({
      method: 'GET',
      url: '/v1/me/sections',
      headers: bearer(coord.accessToken),
    });
    expect(coordRes.json<{ classSectionIds: string[] }>().classSectionIds).toEqual(
      [ctx.sections.a1, ctx.sections.a2].sort(),
    );
  });
});

describe('sync endpoints', () => {
  it('require the internal token or an admin of the same institution', async () => {
    const payload = {
      institutionId: INSTITUTION_A,
      sections: [{ classSectionId: randomUUID(), professorId: null }],
    };
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/v1/sync/sections', payload })).statusCode,
    ).toBe(401);

    const student = await login(ctx, ctx.users.student);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/v1/sync/sections',
          headers: bearer(student.accessToken),
          payload,
        })
      ).statusCode,
    ).toBe(403);

    const adminB = await login(ctx, ctx.users.adminB);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/v1/sync/sections',
          headers: bearer(adminB.accessToken),
          payload,
        })
      ).statusCode,
    ).toBe(403);

    const admin = await login(ctx, ctx.users.admin);
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/v1/sync/sections',
      headers: bearer(admin.accessToken),
      payload,
    });
    expect(ok.json()).toEqual({ upserted: 1, rejected: 0 });
  });

  it('never moves a section to another institution', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/sync/sections',
      headers: internal,
      payload: {
        institutionId: INSTITUTION_B,
        sections: [{ classSectionId: ctx.sections.a1, professorId: null }],
      },
    });
    expect(res.json()).toEqual({ upserted: 0, rejected: 1 });
    expect((await ctx.deps.repos.access.findSection(ctx.sections.a1))?.institutionId).toBe(
      INSTITUTION_A,
    );
  });
});

describe('POST /v1/users', () => {
  const newUser = (overrides: Record<string, unknown> = {}) => ({
    institutionId: INSTITUTION_A,
    email: 'Nova.Aluna@Example.edu.br',
    name: 'Nova Aluna',
    role: 'student',
    studentId: randomUUID(),
    password: 'uma-senha-bem-longa',
    ...overrides,
  });

  it('lets an admin create a user who can then log in', async () => {
    const admin = await login(ctx, ctx.users.admin);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: bearer(admin.accessToken),
      payload: newUser(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: 'nova.aluna@example.edu.br', role: 'student' });
    const loginRes = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'nova.aluna@example.edu.br',
        password: 'uma-senha-bem-longa',
        institutionId: INSTITUTION_A,
      },
    });
    expect(loginRes.statusCode).toBe(200);
  });

  it('is admin-only and tenant-scoped', async () => {
    const coordinator = await login(ctx, ctx.users.coordinator);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/v1/users',
          headers: bearer(coordinator.accessToken),
          payload: newUser(),
        })
      ).statusCode,
    ).toBe(403);
    const adminB = await login(ctx, ctx.users.adminB);
    const cross = await ctx.app.inject({
      method: 'POST',
      url: '/v1/users',
      headers: bearer(adminB.accessToken),
      payload: newUser(),
    });
    expect(cross.statusCode).toBe(403);
    expect(cross.json<{ error: { code: string } }>().error.code).toBe('cross_institution');
  });

  it('validates role links, password length and duplicates', async () => {
    const admin = await login(ctx, ctx.users.admin);
    const post = (payload: Record<string, unknown>) =>
      ctx.app.inject({
        method: 'POST',
        url: '/v1/users',
        headers: bearer(admin.accessToken),
        payload,
      });
    expect((await post(newUser({ studentId: undefined }))).statusCode).toBe(400);
    expect((await post(newUser({ role: 'professor' }))).statusCode).toBe(400);
    expect((await post(newUser({ password: 'short' }))).statusCode).toBe(400);
    expect((await post(newUser())).statusCode).toBe(201);
    expect((await post(newUser())).statusCode).toBe(409);
    expect(INSTITUTION_B).not.toBe(INSTITUTION_A);
  });
});
