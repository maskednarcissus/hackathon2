import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type {
  Campus,
  Classroom,
  HoldingCompany,
  Institution,
  PolicySource,
  RecordingPolicy,
} from './domain.js';
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
  RecordingPolicyUpdate,
} from './schemas.js';

export interface Clock {
  now(): Date;
}

export interface OrganizationDeps {
  repo: OrganizationRepository;
  clock: Clock;
  idGenerator: () => string;
}

export interface BuildAppOptions {
  deps?: Partial<OrganizationDeps>;
  logger?: FastifyServerOptions['logger'];
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

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const deps: OrganizationDeps = {
    repo: options.deps?.repo ?? createInMemoryOrganizationRepository(),
    clock: options.deps?.clock ?? { now: () => new Date() },
    idGenerator: options.deps?.idGenerator ?? randomUUID,
  };
  const { repo, clock } = deps;
  const app = Fastify({ logger: options.logger ?? false });
  registerErrorHandler(app);

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
    for (const p of await repo.recordingPolicies.list((p) => p.institutionId === id))
      await repo.recordingPolicies.delete(p.id);
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
  ): Promise<Classroom & { institutionId: string; timezone: string }> => {
    const campus = await requireCampus(classroom.campusId);
    return { ...classroom, institutionId: campus.institutionId, timezone: campus.timezone };
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
    return {
      classroomId: id,
      campusId: campus.id,
      institutionId: campus.institutionId,
      timezone: campus.timezone,
      source,
      policy,
    };
  });

  // ---------------------------------------------------------------- recording policies
  /** Only one default policy per institution: setting a new default clears the previous one. */
  const clearOtherDefaults = async (institutionId: string, keepId: string): Promise<void> => {
    for (const p of await repo.recordingPolicies.list(
      (p) => p.institutionId === institutionId && p.isDefault && p.id !== keepId,
    )) {
      await repo.recordingPolicies.save({ ...p, isDefault: false, updatedAt: now() });
    }
  };

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
    const item: RecordingPolicy = stripUndefined({
      id: deps.idGenerator(),
      institutionId: id,
      ...body,
      // The first policy of an institution becomes its default automatically.
      isDefault: body.isDefault || existing.length === 0,
      createdAt: ts,
      updatedAt: ts,
    });
    await repo.recordingPolicies.save(item);
    if (item.isDefault) await clearOtherDefaults(id, item.id);
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
    const saved = await repo.recordingPolicies.save({
      ...applyPatch(current, patch),
      updatedAt: now(),
    });
    if (saved.isDefault) await clearOtherDefaults(saved.institutionId, saved.id);
    return saved;
  });

  return app;
}
