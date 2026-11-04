import { randomUUID } from 'node:crypto';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import {
  InMemoryAuditClient,
  StaticRosterClient,
  type AuditClient,
  type RetentionTarget,
  type RosterClient,
} from './clients.js';
import type { Clock, ServiceContext } from './context.js';
import {
  POLICY_CONTENT_FIELDS,
  type Campus,
  type Classroom,
  type HoldingCompany,
  type Institution,
  type PolicyContent,
  type PolicySource,
  type RecordingPolicy,
  type RecordingPolicyVersion,
} from './domain.js';
import { computeConsentStatus, registerGovernanceRoutes } from './governance.js';
import { createInternalGuard, tokenMatches } from './internal-auth.js';
import { registerRetentionRoutes } from './retention.js';
import { AppError, conflict, notFound, registerErrorHandler } from './errors.js';
import { createInMemoryOrganizationRepository, type OrganizationRepository } from './repository.js';
import {
  CampusCreate,
  CampusUpdate,
  ClassroomCreate,
  ClassroomUpdate,
  HoldingCompanyCreate,
  HoldingCompanyUpdate,
  IdParams,
  InstitutionCreate,
  InstitutionUpdate,
  ListQuery,
  RecordingPolicyCreate,
  RecordingPolicyQuery,
  RecordingPolicyUpdate,
  VersionParams,
} from './schemas.js';

export type { Clock } from './context.js';

export interface OrganizationDeps {
  repo: OrganizationRepository;
  clock: Clock;
  idGenerator: () => string;
  audit: AuditClient;
  roster: RosterClient;
  retentionTargets: readonly RetentionTarget[];
}

export interface BuildAppOptions {
  deps?: Partial<OrganizationDeps>;
  logger?: FastifyServerOptions['logger'];
  /** Pre-built pino logger (takes precedence over `logger`). */
  loggerInstance?: FastifyBaseLogger;
  /**
   * When set, scheduler endpoints (`POST /v1/retention/run`) and `/internal/*` require
   * `x-internal-token` — or `Authorization: Bearer <adminToken>` for the admin console.
   */
  internalToken?: string;
  adminToken?: string;
}

/** Removes keys whose value is undefined; turns null into "delete the field". */
function applyPatch<T extends object>(target: T, patch: Record<string, unknown>): T {
  const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete result[key];
    else result[key] = value;
  }
  return result as unknown as T;
}

type Defined<T> = { [K in keyof T]: Exclude<T[K], undefined> };

function stripUndefined<T extends object>(obj: T): Defined<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Defined<T>;
}

/** Internal token (scheduler / services) or the admin bearer token (administration console). */
function createSchedulerGuard(
  internalToken: string | undefined,
  adminToken: string | undefined,
): (request: FastifyRequest) => Promise<void> {
  const internal = createInternalGuard(internalToken);
  return (request) => {
    const auth = request.headers.authorization;
    if (adminToken && auth?.startsWith('Bearer ') && tokenMatches(auth.slice(7), adminToken)) {
      return Promise.resolve();
    }
    return internal(request);
  };
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const deps: OrganizationDeps = {
    repo: options.deps?.repo ?? createInMemoryOrganizationRepository(),
    clock: options.deps?.clock ?? { now: () => new Date() },
    idGenerator: options.deps?.idGenerator ?? randomUUID,
    audit: options.deps?.audit ?? new InMemoryAuditClient(),
    roster: options.deps?.roster ?? new StaticRosterClient(),
    retentionTargets: options.deps?.retentionTargets ?? [],
  };
  const { repo, clock } = deps;
  const app: FastifyInstance = options.loggerInstance
    ? (Fastify({ loggerInstance: options.loggerInstance }) as unknown as FastifyInstance)
    : Fastify({ logger: options.logger ?? false });
  registerErrorHandler(app);
  const requireInternal = createInternalGuard(options.internalToken);
  app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/internal/')) await requireInternal(request);
  });

  const now = (): string => clock.now().toISOString();

  const requireHolding = async (id: string): Promise<HoldingCompany> => {
    const item = await repo.holdingCompanies.get(id);
    if (!item) throw notFound('Holding company', id);
    return item;
  };
  const requireInstitution = async (id: string): Promise<Institution> => {
    const item = await repo.institutions.get(id);
    if (!item) throw notFound('Institution', id);
    return item;
  };
  const requireCampus = async (id: string): Promise<Campus> => {
    const item = await repo.campuses.get(id);
    if (!item) throw notFound('Campus', id);
    return item;
  };
  const requireClassroom = async (id: string): Promise<Classroom> => {
    const item = await repo.classrooms.get(id);
    if (!item) throw notFound('Classroom', id);
    return item;
  };
  const requirePolicy = async (id: string): Promise<RecordingPolicy> => {
    const item = await repo.recordingPolicies.get(id);
    if (!item) throw notFound('Recording policy', id);
    return item;
  };

  const ctx: ServiceContext = {
    repo,
    clock,
    idGenerator: deps.idGenerator,
    audit: deps.audit,
    roster: deps.roster,
    retentionTargets: deps.retentionTargets,
    requireInstitution,
    requirePolicy,
    defaultPolicy: async (institutionId) =>
      (
        await repo.recordingPolicies.list((p) => p.institutionId === institutionId && p.isDefault)
      )[0],
    recordAudit: (event) =>
      deps.audit.record(event).catch((err: unknown) => {
        app.log.warn({ err, action: event.action }, 'audit client threw');
      }),
  };

  /** Snapshot of the content fields; versions are immutable copies of this. */
  const contentOf = (p: RecordingPolicy): PolicyContent =>
    Object.fromEntries(
      POLICY_CONTENT_FIELDS.filter((f) => p[f] !== undefined).map((f) => [f, p[f]]),
    ) as PolicyContent;

  const buildVersion = (
    policy: Omit<RecordingPolicy, 'currentVersion' | 'currentVersionId'>,
    version: number,
    changedFields: RecordingPolicyVersion['changedFields'],
    createdBy: string | null,
    changeReason: string | undefined,
  ): RecordingPolicyVersion => ({
    id: deps.idGenerator(),
    policyId: policy.id,
    institutionId: policy.institutionId,
    version,
    content: contentOf({ ...policy, currentVersion: version, currentVersionId: '' }),
    changedFields,
    ...(changeReason ? { changeReason } : {}),
    createdBy,
    createdAt: now(),
  });

  const auditVersion = (record: RecordingPolicyVersion): Promise<void> =>
    ctx.recordAudit({
      tenantId: record.institutionId,
      actorId: record.createdBy,
      actorType: record.createdBy ? 'admin' : 'system',
      action: 'recording_policy.version_created',
      resourceType: 'recording_policy',
      resourceId: record.policyId,
      metadata: {
        version: record.version,
        versionId: record.id,
        changedFields: record.changedFields,
        changeReason: record.changeReason ?? null,
      },
    });

  /** A policy referenced by a campus/classroom must belong to the same institution (tenant isolation). */
  const assertPolicyInInstitution = async (
    policyId: string,
    institutionId: string,
  ): Promise<void> => {
    const policy = await repo.recordingPolicies.get(policyId);
    if (!policy || policy.institutionId !== institutionId) {
      throw new AppError(
        422,
        'invalid_recording_policy',
        `Recording policy ${policyId} does not belong to institution ${institutionId}`,
      );
    }
  };

  const sameName = (a: string, b: string): boolean =>
    a.trim().toLowerCase() === b.trim().toLowerCase();

  app.get('/health', () => ({ status: 'ok', service: 'organization' }));

  // ---------------------------------------------------------------- holding companies
  app.post('/v1/holding-companies', async (request, reply) => {
    const body = HoldingCompanyCreate.parse(request.body);
    const existing = await repo.holdingCompanies.list((h) => sameName(h.name, body.name));
    if (existing.length > 0)
      throw conflict('duplicate_name', `Holding company "${body.name}" already exists`);
    const ts = now();
    const item: HoldingCompany = { id: deps.idGenerator(), ...body, createdAt: ts, updatedAt: ts };
    await repo.holdingCompanies.save(item);
    return reply.status(201).send(item);
  });
  app.get('/v1/holding-companies', async () => ({ items: await repo.holdingCompanies.list() }));
  app.get('/v1/holding-companies/:id', async (request) =>
    requireHolding(IdParams.parse(request.params).id),
  );
  app.patch('/v1/holding-companies/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const patch = HoldingCompanyUpdate.parse(request.body);
    const current = await requireHolding(id);
    if (patch.name !== undefined) {
      const dup = await repo.holdingCompanies.list(
        (h) => h.id !== id && sameName(h.name, patch.name ?? ''),
      );
      if (dup.length > 0)
        throw conflict('duplicate_name', `Holding company "${patch.name}" already exists`);
    }
    return repo.holdingCompanies.save({ ...applyPatch(current, patch), updatedAt: now() });
  });
  app.delete('/v1/holding-companies/:id', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await requireHolding(id);
    const children = await repo.institutions.list((i) => i.holdingCompanyId === id);
    if (children.length > 0)
      throw conflict('has_children', 'Holding company still has institutions');
    await repo.holdingCompanies.delete(id);
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- institutions
  app.post('/v1/institutions', async (request, reply) => {
    const body = InstitutionCreate.parse(request.body);
    await requireHolding(body.holdingCompanyId);
    const dup = await repo.institutions.list(
      (i) => i.holdingCompanyId === body.holdingCompanyId && sameName(i.name, body.name),
    );
    if (dup.length > 0)
      throw conflict(
        'duplicate_name',
        `Institution "${body.name}" already exists in this holding company`,
      );
    const ts = now();
    const item: Institution = stripUndefined({
      id: deps.idGenerator(),
      ...body,
      createdAt: ts,
      updatedAt: ts,
    });
    await repo.institutions.save(item);
    return reply.status(201).send(item);
  });
  app.get('/v1/institutions', async (request) => {
    const q = ListQuery.parse(request.query);
    return {
      items: await repo.institutions.list(
        (i) => !q.holdingCompanyId || i.holdingCompanyId === q.holdingCompanyId,
      ),
    };
  });
  app.get('/v1/institutions/:id', async (request) =>
    requireInstitution(IdParams.parse(request.params).id),
  );
  app.patch('/v1/institutions/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const patch = InstitutionUpdate.parse(request.body);
    const current = await requireInstitution(id);
    if (patch.name !== undefined) {
      const dup = await repo.institutions.list(
        (i) =>
          i.id !== id &&
          i.holdingCompanyId === current.holdingCompanyId &&
          sameName(i.name, patch.name ?? ''),
      );
      if (dup.length > 0)
        throw conflict(
          'duplicate_name',
          `Institution "${patch.name}" already exists in this holding company`,
        );
    }
    return repo.institutions.save({ ...applyPatch(current, patch), updatedAt: now() });
  });
  app.delete('/v1/institutions/:id', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await requireInstitution(id);
    const campuses = await repo.campuses.list((c) => c.institutionId === id);
    if (campuses.length > 0) throw conflict('has_children', 'Institution still has campuses');
    // Policies have immutable versions (and recordings reference them): never deleted.
    const policies = await repo.recordingPolicies.list(undefined, { institutionId: id });
    if (policies.length > 0)
      throw conflict('has_children', 'Institution has recording policies (kept for governance)');
    await repo.institutions.delete(id);
    return reply.status(204).send();
  });
  app.get('/v1/institutions/:id/tree', async (request) => {
    const { id } = IdParams.parse(request.params);
    const institution = await requireInstitution(id);
    const campuses = await repo.campuses.list((c) => c.institutionId === id);
    const campusIds = new Set(campuses.map((c) => c.id));
    const classrooms = await repo.classrooms.list((c) => campusIds.has(c.campusId));
    const byName = <T extends { name: string }>(a: T, b: T): number =>
      a.name.localeCompare(b.name, 'pt-BR');
    return {
      institution,
      recordingPolicies: (await repo.recordingPolicies.list((p) => p.institutionId === id)).sort(
        byName,
      ),
      campuses: campuses.sort(byName).map((campus) => ({
        ...campus,
        classrooms: classrooms
          .filter((c) => c.campusId === campus.id)
          .sort((a, b) => a.code.localeCompare(b.code)),
      })),
    };
  });

  // ---------------------------------------------------------------- campuses
  app.post('/v1/campuses', async (request, reply) => {
    const body = CampusCreate.parse(request.body);
    await requireInstitution(body.institutionId);
    const dup = await repo.campuses.list(
      (c) => c.institutionId === body.institutionId && sameName(c.name, body.name),
    );
    if (dup.length > 0)
      throw conflict('duplicate_name', `Campus "${body.name}" already exists in this institution`);
    if (body.recordingPolicyId)
      await assertPolicyInInstitution(body.recordingPolicyId, body.institutionId);
    const ts = now();
    const item: Campus = stripUndefined({
      id: deps.idGenerator(),
      ...body,
      createdAt: ts,
      updatedAt: ts,
    });
    await repo.campuses.save(item);
    return reply.status(201).send(item);
  });
  app.get('/v1/campuses', async (request) => {
    const q = ListQuery.parse(request.query);
    return {
      items: await repo.campuses.list(
        (c) => !q.institutionId || c.institutionId === q.institutionId,
      ),
    };
  });
  app.get('/v1/campuses/:id', async (request) => requireCampus(IdParams.parse(request.params).id));
  app.patch('/v1/campuses/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const patch = CampusUpdate.parse(request.body);
    const current = await requireCampus(id);
    if (patch.name !== undefined) {
      const dup = await repo.campuses.list(
        (c) =>
          c.id !== id &&
          c.institutionId === current.institutionId &&
          sameName(c.name, patch.name ?? ''),
      );
      if (dup.length > 0)
        throw conflict(
          'duplicate_name',
          `Campus "${patch.name}" already exists in this institution`,
        );
    }
    if (patch.recordingPolicyId)
      await assertPolicyInInstitution(patch.recordingPolicyId, current.institutionId);
    return repo.campuses.save({ ...applyPatch(current, patch), updatedAt: now() });
  });
  app.delete('/v1/campuses/:id', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await requireCampus(id);
    const rooms = await repo.classrooms.list((c) => c.campusId === id);
    if (rooms.length > 0) throw conflict('has_children', 'Campus still has classrooms');
    await repo.campuses.delete(id);
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- classrooms
  const classroomView = async (
    classroom: Classroom,
  ): Promise<Classroom & { institutionId: string; timezone: string; campusName: string }> => {
    const campus = await requireCampus(classroom.campusId);
    return {
      ...classroom,
      institutionId: campus.institutionId,
      timezone: campus.timezone,
      campusName: campus.name,
    };
  };

  app.post('/v1/classrooms', async (request, reply) => {
    const body = ClassroomCreate.parse(request.body);
    const campus = await requireCampus(body.campusId);
    const dup = await repo.classrooms.list(
      (c) => c.campusId === body.campusId && sameName(c.code, body.code),
    );
    if (dup.length > 0)
      throw conflict(
        'duplicate_code',
        `Classroom code "${body.code}" already exists in this campus`,
      );
    if (body.recordingPolicyId)
      await assertPolicyInInstitution(body.recordingPolicyId, campus.institutionId);
    const ts = now();
    const item: Classroom = stripUndefined({
      id: deps.idGenerator(),
      ...body,
      createdAt: ts,
      updatedAt: ts,
    });
    await repo.classrooms.save(item);
    return reply.status(201).send(await classroomView(item));
  });
  app.get('/v1/classrooms', async (request) => {
    const q = ListQuery.parse(request.query);
    let campusIds: Set<string> | undefined;
    if (q.institutionId) {
      const institutionId = q.institutionId;
      campusIds = new Set(
        (await repo.campuses.list((c) => c.institutionId === institutionId)).map((c) => c.id),
      );
    }
    const rooms = await repo.classrooms.list(
      (c) =>
        (!q.campusId || c.campusId === q.campusId) && (!campusIds || campusIds.has(c.campusId)),
    );
    return { items: await Promise.all(rooms.map(classroomView)) };
  });
  app.get('/v1/classrooms/:id', async (request) =>
    classroomView(await requireClassroom(IdParams.parse(request.params).id)),
  );
  app.patch('/v1/classrooms/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const patch = ClassroomUpdate.parse(request.body);
    const current = await requireClassroom(id);
    const campus = await requireCampus(current.campusId);
    if (patch.code !== undefined) {
      const dup = await repo.classrooms.list(
        (c) => c.id !== id && c.campusId === current.campusId && sameName(c.code, patch.code ?? ''),
      );
      if (dup.length > 0)
        throw conflict(
          'duplicate_code',
          `Classroom code "${patch.code}" already exists in this campus`,
        );
    }
    if (patch.recordingPolicyId)
      await assertPolicyInInstitution(patch.recordingPolicyId, campus.institutionId);
    const saved = await repo.classrooms.save({ ...applyPatch(current, patch), updatedAt: now() });
    return classroomView(saved);
  });
  app.delete('/v1/classrooms/:id', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await requireClassroom(id);
    await repo.classrooms.delete(id);
    return reply.status(204).send();
  });

  app.get('/v1/classrooms/:id/recording-policy', async (request) => {
    const { id } = IdParams.parse(request.params);
    const { classSectionId } = RecordingPolicyQuery.parse(request.query);
    const classroom = await requireClassroom(id);
    const campus = await requireCampus(classroom.campusId);
    let source: PolicySource | undefined;
    let policy: RecordingPolicy | undefined;
    if (classroom.recordingPolicyId) {
      policy = await repo.recordingPolicies.get(classroom.recordingPolicyId);
      source = 'classroom';
    }
    if (!policy && campus.recordingPolicyId) {
      policy = await repo.recordingPolicies.get(campus.recordingPolicyId);
      source = 'campus';
    }
    if (!policy) {
      [policy] = await repo.recordingPolicies.list(
        (p) => p.institutionId === campus.institutionId && p.isDefault,
      );
      source = 'institution_default';
    }
    if (!policy || !source) {
      throw new AppError(
        404,
        'no_recording_policy',
        `No recording policy applies to classroom ${id}; recording must not start`,
      );
    }
    const resolved = {
      classroomId: id,
      campusId: campus.id,
      institutionId: campus.institutionId,
      timezone: campus.timezone,
      source,
      policy,
      policyVersion: policy.currentVersion,
      policyVersionId: policy.currentVersionId,
    };
    if (!classSectionId) return resolved;
    const consent = await computeConsentStatus(ctx, classSectionId, policy, {
      consultRosterWhenNotRequired: false,
    });
    return {
      ...resolved,
      classSectionId,
      consentSatisfied: consent.consentSatisfied,
      consentStatus: consent,
    };
  });

  // ---------------------------------------------------------------- recording policies
  // Only one default policy per institution: `commitPolicy` clears the previous default.

  app.post('/v1/institutions/:id/recording-policies', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await requireInstitution(id);
    const body = RecordingPolicyCreate.parse(request.body);
    const dup = await repo.recordingPolicies.list(
      (p) => p.institutionId === id && sameName(p.name, body.name),
    );
    if (dup.length > 0)
      throw conflict('duplicate_name', `Recording policy "${body.name}" already exists`);
    const existing = await repo.recordingPolicies.list((p) => p.institutionId === id);
    const ts = now();
    const { actorId, ...fields } = body;
    const draft = stripUndefined({
      id: deps.idGenerator(),
      institutionId: id,
      ...fields,
      // The first policy of an institution becomes its default automatically.
      isDefault: body.isDefault || existing.length === 0,
      createdAt: ts,
      updatedAt: ts,
    });
    const version = buildVersion(draft, 1, [...POLICY_CONTENT_FIELDS], actorId ?? null, 'created');
    const item: RecordingPolicy = { ...draft, currentVersion: 1, currentVersionId: version.id };
    await repo.commitPolicy({ policy: item, version });
    await auditVersion(version);
    return reply.status(201).send(item);
  });
  app.get('/v1/institutions/:id/recording-policies', async (request) => {
    const { id } = IdParams.parse(request.params);
    await requireInstitution(id);
    return { items: await repo.recordingPolicies.list((p) => p.institutionId === id) };
  });
  app.get('/v1/recording-policies/:id', async (request) =>
    requirePolicy(IdParams.parse(request.params).id),
  );
  app.patch('/v1/recording-policies/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const patch = RecordingPolicyUpdate.parse(request.body);
    const current = await requirePolicy(id);
    if (patch.isDefault === false && current.isDefault) {
      throw conflict(
        'default_required',
        'Set another policy as default instead of unsetting the current default',
      );
    }
    const { changeReason, actorId, ...fields } = patch;
    if (fields.name !== undefined) {
      const dup = await repo.recordingPolicies.list(
        (p) =>
          p.id !== id &&
          p.institutionId === current.institutionId &&
          sameName(p.name, fields.name ?? ''),
      );
      if (dup.length > 0)
        throw conflict('duplicate_name', `Recording policy "${fields.name}" already exists`);
    }
    let next: RecordingPolicy = { ...applyPatch(current, fields), updatedAt: now() };
    const changedFields = POLICY_CONTENT_FIELDS.filter((f) => next[f] !== current[f]);
    let version: RecordingPolicyVersion | undefined;
    if (changedFields.length > 0) {
      // Policies are versioned: recordings keep pointing at the version that was in force.
      version = buildVersion(
        next,
        current.currentVersion + 1,
        changedFields,
        actorId ?? null,
        changeReason,
      );
      next = { ...next, currentVersion: version.version, currentVersionId: version.id };
    }
    await repo.commitPolicy({ policy: next, ...(version ? { version } : {}) });
    if (version) await auditVersion(version);
    return next;
  });

  app.get('/v1/recording-policies/:id/versions', async (request) => {
    const { id } = IdParams.parse(request.params);
    await requirePolicy(id);
    const items = await repo.recordingPolicyVersions.list(undefined, { policyId: id });
    return { items: items.sort((a, b) => b.version - a.version) };
  });

  app.get('/v1/recording-policies/:id/versions/:version', async (request) => {
    const { id, version } = VersionParams.parse(request.params);
    await requirePolicy(id);
    const [item] = await repo.recordingPolicyVersions.list((v) => v.version === version, {
      policyId: id,
    });
    if (!item) throw notFound('Recording policy version', `${id}@${version}`);
    return item;
  });

  app.get('/v1/recording-policy-versions/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const item = await repo.recordingPolicyVersions.get(id);
    if (!item) throw notFound('Recording policy version', id);
    return item;
  });

  registerGovernanceRoutes(app, ctx);
  registerRetentionRoutes(
    app,
    ctx,
    createSchedulerGuard(options.internalToken, options.adminToken),
  );

  return app;
}
