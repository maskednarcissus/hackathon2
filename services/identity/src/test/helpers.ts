import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { InMemoryAuditClient } from '../audit-client.js';
import { buildApp, createDefaultDeps, DEFAULT_CONFIG, type AppDeps } from '../app.js';
import { hashPassword } from '../password.js';
import { createInMemoryRepositories, type UserRecord } from '../repositories.js';
import type { Role } from '../jwt-verify.js';

export class MutableClock {
  constructor(private current: Date = new Date('2026-11-04T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Cheap scrypt params so the suite stays fast; the default params are covered in password.test.ts. */
export const FAST_SCRYPT = { N: 2 ** 10, r: 8, p: 1 };
export const PASSWORD = 'correct horse battery staple';
export const INTERNAL_TOKEN = 'internal-test-token';

export const INSTITUTION_A = randomUUID();
export const INSTITUTION_B = randomUUID();

export interface TestContext {
  app: FastifyInstance;
  deps: AppDeps;
  clock: MutableClock;
  audit: InMemoryAuditClient;
  users: Record<
    'admin' | 'student' | 'professor' | 'coordinator' | 'otherStudent' | 'adminB',
    UserRecord
  >;
  sections: { a1: string; a2: string; b1: string };
}

export async function createUser(
  deps: AppDeps,
  input: {
    institutionId: string;
    role: Role;
    email?: string;
    password?: string | null;
    /** studentId / professorId to link (must exist as a students/professors row in Postgres). */
    personId?: string;
  },
): Promise<UserRecord> {
  const now = deps.clock.now();
  const user: UserRecord = {
    id: randomUUID(),
    institutionId: input.institutionId,
    email: (
      input.email ?? `${input.role}-${randomUUID().slice(0, 8)}@example.edu.br`
    ).toLowerCase(),
    name: `Test ${input.role}`,
    role: input.role,
    studentId: input.role === 'student' ? (input.personId ?? randomUUID()) : null,
    professorId: input.role === 'professor' ? (input.personId ?? randomUUID()) : null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  await deps.repos.users.create(user);
  if (input.password !== null) {
    await deps.repos.credentials.save({
      userId: user.id,
      passwordHash: await hashPassword(input.password ?? PASSWORD, FAST_SCRYPT),
      failedAttempts: 0,
      lockedUntil: null,
      passwordUpdatedAt: now,
    });
  }
  return user;
}

export type PersonFactory = (
  institutionId: string,
  kind: 'student' | 'professor',
) => Promise<string>;

export async function setup(
  input: Partial<Omit<AppDeps, 'clock'>> & {
    clock?: MutableClock;
    personFactory?: PersonFactory;
  } = {},
): Promise<TestContext> {
  const { personFactory, ...overrides } = input;
  const person = personFactory ?? (async (): Promise<string> => randomUUID());
  const clock = overrides.clock ?? new MutableClock();
  const audit = new InMemoryAuditClient();
  const deps = createDefaultDeps({
    repos: createInMemoryRepositories(),
    audit,
    ...overrides,
    clock,
    config: {
      ...DEFAULT_CONFIG,
      passwordParams: FAST_SCRYPT,
      internalToken: INTERNAL_TOKEN,
      ...overrides.config,
    },
  });

  const users = {
    admin: await createUser(deps, { institutionId: INSTITUTION_A, role: 'admin' }),
    student: await createUser(deps, {
      institutionId: INSTITUTION_A,
      role: 'student',
      personId: await person(INSTITUTION_A, 'student'),
    }),
    otherStudent: await createUser(deps, {
      institutionId: INSTITUTION_A,
      role: 'student',
      personId: await person(INSTITUTION_A, 'student'),
    }),
    professor: await createUser(deps, {
      institutionId: INSTITUTION_A,
      role: 'professor',
      personId: await person(INSTITUTION_A, 'professor'),
    }),
    coordinator: await createUser(deps, { institutionId: INSTITUTION_A, role: 'coordinator' }),
    adminB: await createUser(deps, { institutionId: INSTITUTION_B, role: 'admin' }),
  };
  const sections = { a1: randomUUID(), a2: randomUUID(), b1: randomUUID() };
  const now = clock.now();
  await deps.repos.access.upsertSection({
    institutionId: INSTITUTION_A,
    classSectionId: sections.a1,
    professorId: users.professor.professorId,
    courseId: null,
    syncedAt: now,
  });
  await deps.repos.access.upsertSection({
    institutionId: INSTITUTION_A,
    classSectionId: sections.a2,
    professorId: randomUUID(),
    courseId: null,
    syncedAt: now,
  });
  await deps.repos.access.upsertSection({
    institutionId: INSTITUTION_B,
    classSectionId: sections.b1,
    professorId: null,
    courseId: null,
    syncedAt: now,
  });
  await deps.repos.access.upsertEnrollment({
    institutionId: INSTITUTION_A,
    studentId: users.student.studentId ?? '',
    classSectionId: sections.a1,
    status: 'active',
    syncedAt: now,
  });

  const app = await buildApp(deps);
  return { app, deps, clock, audit, users, sections };
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; role: string };
}

export async function login(
  ctx: TestContext,
  user: UserRecord,
  password = PASSWORD,
): Promise<LoginResult> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: user.email, password, institutionId: user.institutionId },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return res.json<LoginResult>();
}

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

/** fetch implementation that routes requests to a Fastify app through inject(). */
export function injectFetch(app: FastifyInstance): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const res = await app.inject({ method: 'GET', url: url.pathname + url.search });
    return new Response(res.body, {
      status: res.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}
