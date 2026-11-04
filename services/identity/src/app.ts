import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';
import { InMemoryAuditClient, type AuditActorType, type AuditClient } from './audit-client.js';
import {
  accessibleSectionIds,
  authorizeSectionAccess,
  RESOURCE_TYPES,
  type AuthorizationDecision,
} from './authorization.js';
import { InMemoryDsrRepository, InMemoryExportStore, type DsrDeps } from './dsr.js';
import { registerDsrRoutes } from './dsr-routes.js';
import { AppError, forbidden, parseOrThrow, registerErrorHandler, unauthorized } from './errors.js';
import {
  DEFAULT_AUDIENCE,
  DEFAULT_ISSUER,
  extractBearerToken,
  requireAuth,
  ROLES,
  type AccessTokenClaims,
} from './jwt-verify.js';
import { generateSigningKey, KeyStore } from './keys.js';
import {
  createOidcProviderRegistry,
  IdentityProviderError,
  type IdentityProviderRegistry,
} from './oidc.js';
import {
  createDummyHash,
  DEFAULT_SCRYPT_PARAMS,
  hashPassword,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
  type ScryptParams,
} from './password.js';
import {
  createInMemoryRepositories,
  InMemoryInstitutionDirectory,
  SecretReferenceRequiredError,
  type InstitutionDirectory,
  type Repositories,
  type UserRecord,
} from './repositories.js';
import { systemClock, TokenService, type Clock } from './tokens.js';

export interface IdentityConfig {
  issuer: string;
  audience: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  rotationGraceSeconds: number;
  maxFailedLogins: number;
  lockoutMinutes: number;
  /** Shared secret for service-to-service calls (sync, authorize). Undefined disables it. */
  internalToken: string | undefined;
  passwordParams: ScryptParams;
}

export const DEFAULT_CONFIG: IdentityConfig = {
  issuer: DEFAULT_ISSUER,
  audience: DEFAULT_AUDIENCE,
  accessTokenTtlSeconds: 15 * 60,
  refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
  rotationGraceSeconds: 10,
  maxFailedLogins: 5,
  lockoutMinutes: 15,
  internalToken: undefined,
  passwordParams: DEFAULT_SCRYPT_PARAMS,
};

export interface AppDeps {
  repos: Repositories;
  keyStore: KeyStore;
  clock: Clock;
  audit: AuditClient;
  identityProviders: IdentityProviderRegistry;
  config: IdentityConfig;
  /** Institution → holding company (Phase 5 group executives). */
  institutions: InstitutionDirectory;
  /** LGPD data subject rights workflow (Phase 4 · 4.11). */
  dsr: DsrDeps;
  logger?: FastifyBaseLogger | boolean;
}

export function createDefaultDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const repos = overrides.repos ?? createInMemoryRepositories();
  const clock = overrides.clock ?? systemClock;
  return {
    repos,
    clock,
    keyStore: overrides.keyStore ?? new KeyStore(generateSigningKey()),
    audit: overrides.audit ?? new InMemoryAuditClient(),
    identityProviders:
      overrides.identityProviders ??
      createOidcProviderRegistry(repos.oidcConfigs, {
        states: repos.oidcStates,
        clock,
        fetch: globalThis.fetch,
      }),
    config: { ...DEFAULT_CONFIG, ...overrides.config },
    institutions: overrides.institutions ?? new InMemoryInstitutionDirectory(),
    dsr: overrides.dsr ?? {
      repo: new InMemoryDsrRepository(),
      handlers: [],
      exportStore: new InMemoryExportStore(),
    },
    ...(overrides.logger !== undefined ? { logger: overrides.logger } : {}),
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();
const email = z.string().trim().toLowerCase().email().max(255);

const LoginSchema = z.object({
  email,
  password: z.string().min(1).max(1024),
  institutionId: uuid,
});

const RefreshSchema = z.object({ refreshToken: z.string().min(1).max(512) });

const CreateUserSchema = z
  .object({
    institutionId: uuid,
    email,
    name: z.string().trim().min(1).max(255),
    role: z.enum(ROLES),
    password: z.string().min(PASSWORD_MIN_LENGTH).max(1024).optional(),
    studentId: uuid.optional(),
    professorId: uuid.optional(),
    holdingCompanyId: uuid.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.role === 'group_executive' && !value.holdingCompanyId) {
      ctx.addIssue({
        code: 'custom',
        path: ['holdingCompanyId'],
        message: 'holdingCompanyId is required for group executives',
      });
    }
    if (value.role !== 'group_executive' && value.holdingCompanyId) {
      ctx.addIssue({
        code: 'custom',
        path: ['holdingCompanyId'],
        message: 'holdingCompanyId only applies to group executives',
      });
    }
    if (value.role === 'student' && !value.studentId) {
      ctx.addIssue({
        code: 'custom',
        path: ['studentId'],
        message: 'studentId is required for students',
      });
    }
    if (value.role === 'professor' && !value.professorId) {
      ctx.addIssue({
        code: 'custom',
        path: ['professorId'],
        message: 'professorId is required for professors',
      });
    }
    if (value.role !== 'student' && value.studentId) {
      ctx.addIssue({
        code: 'custom',
        path: ['studentId'],
        message: 'studentId only applies to students',
      });
    }
    if (value.role !== 'professor' && value.professorId) {
      ctx.addIssue({
        code: 'custom',
        path: ['professorId'],
        message: 'professorId only applies to professors',
      });
    }
  });

const SyncEnrollmentsSchema = z.object({
  institutionId: uuid,
  /** replace: enrollments of the listed sections that are absent from the payload become `withdrawn`. */
  mode: z.enum(['upsert', 'replace']).default('upsert'),
  enrollments: z
    .array(
      z.object({
        studentId: uuid,
        classSectionId: uuid,
        status: z.enum(['active', 'withdrawn', 'completed']).default('active'),
      }),
    )
    .max(50_000),
});

const SyncSectionsSchema = z.object({
  institutionId: uuid,
  sections: z
    .array(
      z.object({
        classSectionId: uuid,
        professorId: uuid.nullable().optional(),
        courseId: uuid.nullable().optional(),
      }),
    )
    .max(20_000),
});

const AuthorizeSchema = z.object({
  subject: z.union([
    z.string().min(1),
    z.object({ token: z.string().min(1) }),
    z.object({ userId: uuid }),
  ]),
  action: z.literal('read'),
  resource: z.object({ type: z.enum(RESOURCE_TYPES), classSectionId: uuid }),
});

const OidcConfigSchema = z.object({
  issuer: z.string().url(),
  authorizationEndpoint: z.string().url(),
  tokenEndpoint: z.string().url(),
  jwksUri: z.string().url(),
  clientId: z.string().min(1),
  /** Plain secret: in-memory/dev only. Production uses `clientSecretRef` (e.g. `env:SSO_SECRET_X`). */
  clientSecret: z.string().min(1).nullable().optional(),
  clientSecretRef: z
    .string()
    .regex(/^(none|env:[A-Z][A-Z0-9_]*|sm:\/\/.+)$/, 'Expected none, env:NAME or sm://…')
    .nullable()
    .optional(),
  redirectUri: z.string().url(),
  scopes: z.array(z.string().min(1)).default(['openid', 'email', 'profile']),
});

const InstitutionParams = z.object({ institutionId: uuid });
const CallbackQuery = z.object({
  code: z.string().min(1).max(4096),
  state: z.string().min(1).max(512),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface PublicUser {
  id: string;
  institutionId: string;
  email: string;
  name: string;
  role: UserRecord['role'];
  studentId: string | null;
  professorId: string | null;
  holdingCompanyId: string | null;
}

const publicUser = (u: UserRecord): PublicUser => ({
  id: u.id,
  institutionId: u.institutionId,
  email: u.email,
  name: u.name,
  role: u.role,
  studentId: u.studentId,
  professorId: u.professorId,
  holdingCompanyId: u.holdingCompanyId,
});

/** The audit actor enum has no group role yet: group executives are recorded as admins (metadata keeps the role). */
const actorTypeFor = (role: UserRecord['role'] | undefined): AuditActorType =>
  role === 'group_executive' ? 'admin' : (role ?? 'system');

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { repos, clock, audit, config } = deps;
  const app: FastifyInstance =
    typeof deps.logger === 'object'
      ? Fastify({ loggerInstance: deps.logger, bodyLimit: 8 * 1024 * 1024 })
      : Fastify({ logger: deps.logger ?? false, bodyLimit: 8 * 1024 * 1024 });
  registerErrorHandler(app);
  app.decorateRequest('auth', undefined);

  const tokens = new TokenService(deps.keyStore, repos, clock, config);
  const dummyHash = await createDummyHash(config.passwordParams);

  const authenticated = requireAuth(tokens.verifyAccessToken, {
    isRevoked: (claims) => repos.revokedAccessTokens.isRevoked(claims.jti, clock.now()),
  });
  const adminOnly = requireAuth(tokens.verifyAccessToken, {
    roles: ['admin'],
    isRevoked: (claims) => repos.revokedAccessTokens.isRevoked(claims.jti, clock.now()),
  });

  const hasInternalToken = (request: FastifyRequest): boolean => {
    const provided = request.headers['x-internal-token'];
    if (!config.internalToken || typeof provided !== 'string') return false;
    return timingSafeEqual(digest(provided), digest(config.internalToken));
  };

  /** Bearer claims if a valid, non-revoked token is present; undefined otherwise. */
  const optionalBearer = async (
    request: FastifyRequest,
  ): Promise<AccessTokenClaims | undefined> => {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) return undefined;
    try {
      const claims = await tokens.verifyAccessToken(token);
      if (await repos.revokedAccessTokens.isRevoked(claims.jti, clock.now())) return undefined;
      return claims;
    } catch {
      return undefined;
    }
  };

  /** Service-to-service (internal token) or an admin of the given institution. */
  const requireInternalOrAdmin = async (
    request: FastifyRequest,
    institutionId: string,
  ): Promise<void> => {
    if (hasInternalToken(request)) return;
    const claims = await optionalBearer(request);
    if (!claims) throw unauthorized('Internal token or admin bearer token required');
    if (claims.role !== 'admin') throw forbidden('Admin role required');
    if (claims.inst !== institutionId)
      throw forbidden('Cross-institution access denied', 'cross_institution');
  };

  const currentUser = async (request: FastifyRequest): Promise<UserRecord> => {
    const claims = request.auth;
    if (!claims) throw unauthorized();
    const user = await repos.users.findById(claims.sub);
    if (!user || user.status !== 'active' || user.institutionId !== claims.inst) {
      throw unauthorized('User is not active', 'user_inactive');
    }
    return user;
  };

  // --- Health & keys -------------------------------------------------------

  app.get('/health', async () => ({ status: 'ok', service: 'identity' }));

  app.get('/.well-known/jwks.json', async (_request, reply) => {
    void reply.header('cache-control', 'public, max-age=300');
    return deps.keyStore.jwks();
  });

  // --- Local credentials ---------------------------------------------------

  app.post('/v1/auth/login', async (request, reply) => {
    const body = parseOrThrow(LoginSchema, request.body);
    const now = clock.now();
    const user = await repos.users.findByEmail(body.institutionId, body.email);
    const credential = user ? await repos.credentials.get(user.id) : undefined;
    const auditBase = {
      tenantId: body.institutionId,
      resourceType: 'user',
      ipAddress: request.ip,
      ...(user ? { actorId: user.id, resourceId: user.id } : {}),
      actorType: actorTypeFor(user?.role),
    };

    if (credential?.lockedUntil && credential.lockedUntil.getTime() > now.getTime()) {
      const retryAfter = Math.ceil((credential.lockedUntil.getTime() - now.getTime()) / 1000);
      await audit.record({
        ...auditBase,
        action: 'auth.login_failed',
        metadata: { reason: 'locked' },
      });
      void reply.header('retry-after', String(retryAfter));
      throw new AppError(423, 'account_locked', 'Too many failed attempts; try again later', {
        retryAfterSeconds: retryAfter,
      });
    }

    const passwordOk = await verifyPassword(body.password, credential?.passwordHash ?? dummyHash);
    if (!user || !credential || !passwordOk || user.status !== 'active') {
      if (credential) {
        const lockExpired = credential.lockedUntil !== null;
        const failedAttempts = (lockExpired ? 0 : credential.failedAttempts) + 1;
        const lock = failedAttempts >= config.maxFailedLogins;
        await repos.credentials.save({
          ...credential,
          failedAttempts: lock ? 0 : failedAttempts,
          lockedUntil: lock ? new Date(now.getTime() + config.lockoutMinutes * 60_000) : null,
        });
        if (lock) {
          await audit.record({
            ...auditBase,
            action: 'auth.locked',
            metadata: { lockoutMinutes: config.lockoutMinutes, failedAttempts },
          });
        }
      }
      if (user) {
        await repos.loginEvents.record({
          userId: user.id,
          institutionId: user.institutionId,
          at: now,
          method: 'password',
          outcome: 'failed',
        });
      }
      await audit.record({
        ...auditBase,
        action: 'auth.login_failed',
        metadata: {
          reason:
            !user || !credential ? 'unknown_user' : !passwordOk ? 'bad_password' : 'user_inactive',
        },
      });
      throw unauthorized('Invalid email or password', 'invalid_credentials');
    }

    if (credential.failedAttempts !== 0 || credential.lockedUntil !== null) {
      await repos.credentials.save({ ...credential, failedAttempts: 0, lockedUntil: null });
    }
    const session = await tokens.issueSession(user);
    await repos.loginEvents.record({
      userId: user.id,
      institutionId: user.institutionId,
      at: now,
      method: 'password',
      outcome: 'succeeded',
    });
    await audit.record({
      ...auditBase,
      action: 'auth.login_succeeded',
      metadata: { method: 'password' },
    });
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: session.expiresIn,
      user: publicUser(user),
    };
  });

  app.post('/v1/auth/refresh', async (request) => {
    const body = parseOrThrow(RefreshSchema, request.body);
    const outcome = await tokens.rotate(body.refreshToken);
    if (!outcome.ok) {
      if (outcome.reason === 'reuse_detected') {
        const user = await repos.users.findById(outcome.record.userId);
        await audit.record({
          tenantId: outcome.record.institutionId,
          actorId: outcome.record.userId,
          actorType: actorTypeFor(user?.role),
          action: 'auth.refresh_reuse_detected',
          resourceType: 'refresh_token_family',
          resourceId: outcome.record.familyId,
          ipAddress: request.ip,
          metadata: { revokedTokens: outcome.revokedCount },
        });
      }
      throw unauthorized('Refresh token is invalid', 'invalid_refresh_token');
    }
    return {
      accessToken: outcome.session.accessToken,
      refreshToken: outcome.session.refreshToken,
      expiresIn: outcome.session.expiresIn,
      user: publicUser(outcome.user),
    };
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const body = parseOrThrow(RefreshSchema, request.body);
    const record = await tokens.revokeFamilyOf(body.refreshToken);
    const claims = await optionalBearer(request);
    if (claims) await repos.revokedAccessTokens.revoke(claims.jti, new Date(claims.exp * 1000));
    if (record) {
      const user = await repos.users.findById(record.userId);
      await audit.record({
        tenantId: record.institutionId,
        actorId: record.userId,
        actorType: actorTypeFor(user?.role),
        action: 'auth.logout',
        resourceType: 'refresh_token_family',
        resourceId: record.familyId,
        ipAddress: request.ip,
      });
    }
    return reply.status(204).send();
  });

  // --- Current user ----------------------------------------------------------

  app.get('/v1/me', { preHandler: authenticated }, async (request) =>
    publicUser(await currentUser(request)),
  );

  app.get('/v1/me/sections', { preHandler: authenticated }, async (request) => {
    const user = await currentUser(request);
    return {
      role: user.role,
      institutionId: user.institutionId,
      classSectionIds: await accessibleSectionIds(repos, user),
    };
  });

  // --- Users (admin) ------------------------------------------------------------

  app.post('/v1/users', async (request, reply) => {
    const body = parseOrThrow(CreateUserSchema, request.body);
    // Admin of the institution, or a service with the internal token (provisioning).
    let admin: UserRecord | undefined;
    if (!hasInternalToken(request)) {
      const claims = await optionalBearer(request);
      if (!claims) throw unauthorized('Admin bearer token or internal token required');
      if (claims.role !== 'admin') throw forbidden('Admin role required');
      request.auth = claims;
      admin = await currentUser(request);
      if (body.institutionId !== admin.institutionId) {
        throw forbidden('Admins can only manage users of their institution', 'cross_institution');
      }
    }
    if (body.role === 'group_executive') {
      // Phase 5 §2: the home institution must belong to the executive's holding company.
      const holding = await deps.institutions.holdingCompanyOf(body.institutionId);
      if (holding === undefined || holding !== body.holdingCompanyId) {
        throw forbidden(
          'The institution does not belong to this holding company',
          'holding_company_mismatch',
        );
      }
    }
    if (await repos.users.findByEmail(body.institutionId, body.email)) {
      throw new AppError(
        409,
        'email_taken',
        'A user with this email already exists in the institution',
      );
    }
    const now = clock.now();
    const user: UserRecord = {
      id: randomUUID(),
      institutionId: body.institutionId,
      email: body.email,
      name: body.name,
      role: body.role,
      studentId: body.studentId ?? null,
      professorId: body.professorId ?? null,
      holdingCompanyId: body.holdingCompanyId ?? null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    await repos.users.create(user);
    if (body.password) {
      await repos.credentials.save({
        userId: user.id,
        passwordHash: await hashPassword(body.password, config.passwordParams),
        failedAttempts: 0,
        lockedUntil: null,
        passwordUpdatedAt: now,
      });
    }
    await audit.record({
      tenantId: user.institutionId,
      ...(admin ? { actorId: admin.id } : {}),
      actorType: admin ? 'admin' : 'system',
      action: 'auth.user_created',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { role: user.role, hasPassword: Boolean(body.password) },
    });
    return reply.status(201).send(publicUser(user));
  });

  // --- Access mirror sync --------------------------------------------------------

  app.post('/v1/sync/sections', async (request) => {
    const body = parseOrThrow(SyncSectionsSchema, request.body);
    await requireInternalOrAdmin(request, body.institutionId);
    const now = clock.now();
    let conflicts = 0;
    for (const s of body.sections) {
      const existing = await repos.access.findSection(s.classSectionId);
      if (existing && existing.institutionId !== body.institutionId) {
        conflicts += 1; // never move a section across tenants
        continue;
      }
      await repos.access.upsertSection({
        institutionId: body.institutionId,
        classSectionId: s.classSectionId,
        professorId: s.professorId ?? null,
        courseId: s.courseId ?? null,
        syncedAt: now,
      });
    }
    return { upserted: body.sections.length - conflicts, rejected: conflicts };
  });

  app.post('/v1/sync/enrollments', async (request) => {
    const body = parseOrThrow(SyncEnrollmentsSchema, request.body);
    await requireInternalOrAdmin(request, body.institutionId);
    const now = clock.now();
    let upserted = 0;
    let rejected = 0;
    let withdrawn = 0;
    const seen = new Set<string>();
    for (const e of body.enrollments) {
      const section = await repos.access.findSection(e.classSectionId);
      if (section && section.institutionId !== body.institutionId) {
        rejected += 1;
        continue;
      }
      await repos.access.upsertEnrollment({
        institutionId: body.institutionId,
        ...e,
        syncedAt: now,
      });
      seen.add(`${e.studentId}:${e.classSectionId}`);
      upserted += 1;
    }
    if (body.mode === 'replace') {
      const sectionIds = new Set(body.enrollments.map((e) => e.classSectionId));
      for (const sectionId of sectionIds) {
        for (const existing of await repos.access.listEnrollmentsBySection(sectionId)) {
          const key = `${existing.studentId}:${existing.classSectionId}`;
          if (
            !seen.has(key) &&
            existing.status === 'active' &&
            existing.institutionId === body.institutionId
          ) {
            await repos.access.upsertEnrollment({
              ...existing,
              status: 'withdrawn',
              syncedAt: now,
            });
            withdrawn += 1;
          }
        }
      }
    }
    return { upserted, rejected, withdrawn };
  });

  // --- Authorization -------------------------------------------------------------

  app.post('/v1/authorize', async (request) => {
    const body = parseOrThrow(AuthorizeSchema, request.body);
    const internal = hasInternalToken(request);
    const caller = internal ? undefined : await optionalBearer(request);
    if (!internal && !caller) throw unauthorized('Internal token or bearer token required');

    let subjectUser: UserRecord | undefined;
    const subjectToken =
      typeof body.subject === 'string'
        ? body.subject.split('.').length === 3
          ? body.subject
          : undefined
        : 'token' in body.subject
          ? body.subject.token
          : undefined;
    if (subjectToken !== undefined) {
      try {
        const claims = await tokens.verifyAccessToken(subjectToken);
        if (await repos.revokedAccessTokens.isRevoked(claims.jti, clock.now())) {
          return { allowed: false, reason: 'invalid_token' } satisfies AuthorizationDecision;
        }
        subjectUser = await repos.users.findById(claims.sub);
        if (subjectUser && subjectUser.institutionId !== claims.inst) subjectUser = undefined;
      } catch {
        return { allowed: false, reason: 'invalid_token' } satisfies AuthorizationDecision;
      }
    } else {
      const userId =
        typeof body.subject === 'string'
          ? body.subject
          : 'userId' in body.subject
            ? body.subject.userId
            : '';
      if (!z.string().uuid().safeParse(userId).success) {
        throw new AppError(400, 'validation_error', 'subject must be an access token or a user id');
      }
      subjectUser = await repos.users.findById(userId);
    }

    // A bearer caller may only ask about itself, unless it is staff of the subject's institution.
    if (caller && subjectUser && caller.sub !== subjectUser.id) {
      const staff = caller.role === 'admin' || caller.role === 'coordinator';
      if (!staff || caller.inst !== subjectUser.institutionId) {
        throw forbidden('Cannot query authorization for another user');
      }
    }
    if (caller && !subjectUser && caller.role !== 'admin' && caller.role !== 'coordinator') {
      throw forbidden('Cannot query authorization for another user');
    }

    return authorizeSectionAccess(repos, subjectUser, body.resource.classSectionId);
  });

  // --- OIDC SSO --------------------------------------------------------------------

  app.put('/v1/identity-providers/:institutionId', { preHandler: adminOnly }, async (request) => {
    const { institutionId } = parseOrThrow(InstitutionParams, request.params);
    const body = parseOrThrow(OidcConfigSchema, request.body);
    if (request.auth?.inst !== institutionId)
      throw forbidden('Cross-institution access denied', 'cross_institution');
    const now = clock.now();
    const existing = await repos.oidcConfigs.get(institutionId);
    try {
      await repos.oidcConfigs.save({
        institutionId,
        issuer: body.issuer,
        authorizationEndpoint: body.authorizationEndpoint,
        tokenEndpoint: body.tokenEndpoint,
        jwksUri: body.jwksUri,
        clientId: body.clientId,
        clientSecret: body.clientSecret ?? null,
        clientSecretRef: body.clientSecretRef ?? null,
        redirectUri: body.redirectUri,
        scopes: body.scopes.includes('openid') ? body.scopes : ['openid', ...body.scopes],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    } catch (err) {
      if (err instanceof SecretReferenceRequiredError) {
        throw new AppError(400, 'secret_reference_required', err.message);
      }
      throw err;
    }
    return {
      institutionId,
      issuer: body.issuer,
      clientId: body.clientId,
      redirectUri: body.redirectUri,
    };
  });

  app.get('/v1/auth/oidc/:institutionId/start', async (request, reply) => {
    const { institutionId } = parseOrThrow(InstitutionParams, request.params);
    const provider = await deps.identityProviders.forInstitution(institutionId);
    if (!provider)
      throw new AppError(404, 'sso_not_configured', 'SSO is not configured for this institution');
    const { authorizationUrl } = await provider.startAuthorization();
    const query = request.query as Record<string, unknown>;
    if (query['format'] === 'json') return { authorizationUrl };
    return reply.redirect(authorizationUrl, 302);
  });

  app.get('/v1/auth/oidc/:institutionId/callback', async (request) => {
    const { institutionId } = parseOrThrow(InstitutionParams, request.params);
    const query = request.query as Record<string, unknown>;
    if (typeof query['error'] === 'string') {
      throw new AppError(
        400,
        'sso_denied',
        `Identity provider returned an error: ${query['error']}`,
      );
    }
    const { code, state } = parseOrThrow(CallbackQuery, query);
    const provider = await deps.identityProviders.forInstitution(institutionId);
    if (!provider)
      throw new AppError(404, 'sso_not_configured', 'SSO is not configured for this institution');

    let identity;
    try {
      identity = await provider.completeAuthorization({ code, state });
    } catch (err) {
      if (err instanceof IdentityProviderError) {
        await audit.record({
          tenantId: institutionId,
          actorType: 'system',
          action: 'auth.login_failed',
          resourceType: 'identity_provider',
          ipAddress: request.ip,
          metadata: { method: 'oidc', reason: err.code },
        });
        throw unauthorized('Single sign-on failed', err.code);
      }
      throw err;
    }

    const user = await repos.users.findByEmail(institutionId, identity.email);
    if (!user || user.status !== 'active') {
      await audit.record({
        tenantId: institutionId,
        actorType: 'system',
        action: 'auth.login_failed',
        resourceType: 'identity_provider',
        ipAddress: request.ip,
        metadata: { method: 'oidc', reason: user ? 'user_inactive' : 'user_not_provisioned' },
      });
      throw forbidden('No active account is provisioned for this identity', 'user_not_provisioned');
    }
    const session = await tokens.issueSession(user);
    await repos.loginEvents.record({
      userId: user.id,
      institutionId,
      at: clock.now(),
      method: 'oidc',
      outcome: 'succeeded',
    });
    await audit.record({
      tenantId: institutionId,
      actorId: user.id,
      actorType: actorTypeFor(user.role),
      action: 'auth.login_succeeded',
      resourceType: 'user',
      resourceId: user.id,
      ipAddress: request.ip,
      metadata: { method: 'oidc', issuer: identity.issuer },
    });
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: session.expiresIn,
      user: publicUser(user),
    };
  });

  registerDsrRoutes(app, {
    repos,
    clock,
    audit,
    dsr: deps.dsr,
    hasInternalToken,
    optionalBearer,
  });

  return app;
}
