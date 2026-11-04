import type { FastifyInstance } from 'fastify';
import { UpstreamError } from './clients.js';
import type { ServiceContext } from './context.js';
import type { Consent, ConsentSubjectType, LegalHold, RecordingPolicy } from './domain.js';
import { AppError, conflict, notFound } from './errors.js';
import {
  ConsentCreate,
  ConsentQuery,
  ConsentStatusQuery,
  ConsentWithdraw,
  IdParams,
  LegalHoldCreate,
  LegalHoldQuery,
  LegalHoldRelease,
} from './schemas.js';

export interface ConsentStatus {
  classSectionId: string;
  policyId: string;
  policyVersion: number;
  requiresExplicitConsent: boolean;
  recordingEnabled: boolean;
  /** null when consent is not required and the roster was not consulted. */
  professorsConsented: number | null;
  professorsTotal: number | null;
  allProfessorsConsented: boolean;
  studentsConsented: number | null;
  studentsDeclined: number | null;
  studentsTotal: number | null;
  /** True when the policy needs no consent, or every professor and enrolled student consented. */
  consentSatisfied: boolean;
  /** consentSatisfied and the policy enables recording. */
  recordingAllowed: boolean;
  reason?: 'policy_disabled' | 'consent_missing';
}

/** Section-specific consent wins over a policy-wide one; superseded records are ignored. */
export function effectiveConsent(
  consents: readonly Consent[],
  subjectType: ConsentSubjectType,
  subjectId: string,
  policyId: string,
  classSectionId: string,
): Consent | undefined {
  const relevant = consents.filter(
    (c) =>
      !c.supersededAt &&
      c.subjectType === subjectType &&
      c.subjectId === subjectId &&
      c.policyId === policyId &&
      (c.classSectionId === undefined || c.classSectionId === classSectionId),
  );
  return relevant.find((c) => c.classSectionId === classSectionId) ?? relevant[0];
}

const isActive = (c: Consent | undefined): boolean => Boolean(c?.given && !c.withdrawnAt);
const declined = (c: Consent | undefined): boolean =>
  c !== undefined && (!c.given || c.withdrawnAt !== undefined);

export async function computeConsentStatus(
  ctx: ServiceContext,
  classSectionId: string,
  policy: RecordingPolicy,
  options: { consultRosterWhenNotRequired: boolean } = { consultRosterWhenNotRequired: true },
): Promise<ConsentStatus> {
  const base = {
    classSectionId,
    policyId: policy.id,
    policyVersion: policy.currentVersion,
    requiresExplicitConsent: policy.requiresExplicitConsent,
    recordingEnabled: policy.recordingEnabled,
  };
  if (!policy.requiresExplicitConsent && !options.consultRosterWhenNotRequired) {
    return {
      ...base,
      professorsConsented: null,
      professorsTotal: null,
      allProfessorsConsented: true,
      studentsConsented: null,
      studentsDeclined: null,
      studentsTotal: null,
      consentSatisfied: true,
      recordingAllowed: policy.recordingEnabled,
      ...(policy.recordingEnabled ? {} : { reason: 'policy_disabled' as const }),
    };
  }

  let roster;
  try {
    roster = await ctx.roster.getRoster(classSectionId);
  } catch (err) {
    if (err instanceof UpstreamError)
      throw new AppError(502, 'upstream_unavailable', err.message, { service: err.service });
    throw err;
  }
  if (!roster) throw notFound('Class section', classSectionId);
  if (roster.institutionId !== policy.institutionId) {
    throw new AppError(
      422,
      'invalid_recording_policy',
      'Policy and class section belong to different institutions',
    );
  }

  const consents = await ctx.repo.consents.list((c) => !c.supersededAt, { policyId: policy.id });
  const prof = roster.professorIds.map((id) =>
    effectiveConsent(consents, 'professor', id, policy.id, classSectionId),
  );
  const stud = roster.studentIds.map((id) =>
    effectiveConsent(consents, 'student', id, policy.id, classSectionId),
  );
  const professorsConsented = prof.filter(isActive).length;
  const studentsConsented = stud.filter(isActive).length;
  const allProfessorsConsented =
    roster.professorIds.length > 0 && professorsConsented === roster.professorIds.length;
  const consentOk =
    !policy.requiresExplicitConsent ||
    (allProfessorsConsented && studentsConsented === roster.studentIds.length);
  const recordingAllowed = policy.recordingEnabled && consentOk;
  let reason: ConsentStatus['reason'];
  if (!policy.recordingEnabled) reason = 'policy_disabled';
  else if (!consentOk) reason = 'consent_missing';
  return {
    ...base,
    professorsConsented,
    professorsTotal: roster.professorIds.length,
    allProfessorsConsented,
    studentsConsented,
    studentsDeclined: stud.filter(declined).length,
    studentsTotal: roster.studentIds.length,
    consentSatisfied: consentOk,
    recordingAllowed,
    ...(reason ? { reason } : {}),
  };
}

export function registerGovernanceRoutes(app: FastifyInstance, ctx: ServiceContext): void {
  const { repo } = ctx;
  const now = (): string => ctx.clock.now().toISOString();

  // ---------------------------------------------------------------- consents (4.10)
  app.post('/v1/consents', async (request, reply) => {
    const body = ConsentCreate.parse(request.body);
    const policy = await ctx.requirePolicy(body.policyId);
    const ts = now();
    const consent: Consent = {
      id: ctx.idGenerator(),
      institutionId: policy.institutionId,
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      policyId: policy.id,
      policyVersion: policy.currentVersion,
      ...(body.classSectionId ? { classSectionId: body.classSectionId } : {}),
      given: body.given,
      actorId: body.actorId,
      recordedAt: ts,
    };
    // A new decision for the same subject/policy/scope supersedes the previous one (history kept).
    const previous = await repo.consents.list(
      (c) =>
        !c.supersededAt &&
        c.subjectType === body.subjectType &&
        c.classSectionId === body.classSectionId,
      { subjectId: body.subjectId, policyId: body.policyId },
    );
    await repo.recordConsent(consent, previous);
    await ctx.recordAudit({
      tenantId: policy.institutionId,
      actorId: body.actorId,
      actorType: body.actorId === body.subjectId ? body.subjectType : 'admin',
      action: 'consent.recorded',
      resourceType: 'recording_consent',
      resourceId: consent.id,
      metadata: {
        subjectType: body.subjectType,
        subjectId: body.subjectId,
        policyId: policy.id,
        policyVersion: policy.currentVersion,
        classSectionId: body.classSectionId ?? null,
        given: body.given,
        supersedes: previous.map((p) => p.id),
      },
    });
    return reply.status(201).send(consent);
  });

  app.get('/v1/consents', async (request) => {
    const q = ConsentQuery.parse(request.query);
    const scope = {
      ...(q.policyId ? { policyId: q.policyId } : {}),
      ...(q.classSectionId ? { classSectionId: q.classSectionId } : {}),
      ...(q.subjectId ? { subjectId: q.subjectId } : {}),
    };
    const items = await repo.consents.list(
      (c) => q.includeHistory === true || !c.supersededAt,
      scope,
    );
    return { items: items.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)) };
  });

  app.get('/v1/consents/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const consent = await repo.consents.get(id);
    if (!consent) throw notFound('Consent', id);
    return consent;
  });

  app.post('/v1/consents/:id/withdraw', async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = ConsentWithdraw.parse(request.body);
    const consent = await repo.consents.get(id);
    if (!consent) throw notFound('Consent', id);
    if (consent.supersededAt)
      throw conflict('consent_superseded', 'Consent was superseded by a newer decision');
    if (consent.withdrawnAt) throw conflict('consent_withdrawn', 'Consent was already withdrawn');
    if (!consent.given) throw conflict('consent_not_given', 'A refusal cannot be withdrawn');
    const updated: Consent = {
      ...consent,
      withdrawnAt: now(),
      withdrawnBy: body.actorId,
      ...(body.reason ? { withdrawalReason: body.reason } : {}),
    };
    await repo.consents.save(updated);
    await ctx.recordAudit({
      tenantId: consent.institutionId,
      actorId: body.actorId,
      actorType: body.actorId === consent.subjectId ? consent.subjectType : 'admin',
      action: 'consent.withdrawn',
      resourceType: 'recording_consent',
      resourceId: id,
      metadata: {
        subjectType: consent.subjectType,
        subjectId: consent.subjectId,
        policyId: consent.policyId,
        classSectionId: consent.classSectionId ?? null,
      },
    });
    return updated;
  });

  app.get('/v1/class-sections/:id/consent-status', async (request) => {
    const { id } = IdParams.parse(request.params);
    const q = ConsentStatusQuery.parse(request.query);
    let policy: RecordingPolicy | undefined;
    if (q.policyId) {
      policy = await ctx.requirePolicy(q.policyId);
    } else {
      const roster = await ctx.roster.getRoster(id).catch((err: unknown) => {
        throw err instanceof UpstreamError
          ? new AppError(502, 'upstream_unavailable', err.message, { service: err.service })
          : err;
      });
      if (!roster) throw notFound('Class section', id);
      policy = await ctx.defaultPolicy(roster.institutionId);
    }
    if (!policy)
      throw new AppError(404, 'no_recording_policy', 'No recording policy applies to this section');
    return computeConsentStatus(ctx, id, policy);
  });

  // ---------------------------------------------------------------- legal holds (4.12)
  app.post('/v1/legal-holds', async (request, reply) => {
    const body = LegalHoldCreate.parse(request.body);
    await ctx.requireInstitution(body.institutionId);
    const hold: LegalHold = {
      id: ctx.idGenerator(),
      institutionId: body.institutionId,
      scope: body.scope,
      reason: body.reason,
      createdBy: body.actorId,
      createdAt: now(),
    };
    await repo.legalHolds.save(hold);
    await ctx.recordAudit({
      tenantId: body.institutionId,
      actorId: body.actorId,
      actorType: 'admin',
      action: 'legal_hold.created',
      resourceType: 'legal_hold',
      resourceId: hold.id,
      metadata: { scope: body.scope, reason: body.reason },
    });
    return reply.status(201).send(hold);
  });

  app.get('/v1/legal-holds', async (request) => {
    const q = LegalHoldQuery.parse(request.query);
    const items = await repo.legalHolds.list(
      (h) => q.active === undefined || q.active === (h.releasedAt === undefined),
      { institutionId: q.institutionId },
    );
    return { items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  });

  app.get('/v1/legal-holds/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const hold = await repo.legalHolds.get(id);
    if (!hold) throw notFound('Legal hold', id);
    return hold;
  });

  /** Releases (never erases) a hold: the record stays for accountability. */
  app.delete('/v1/legal-holds/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = LegalHoldRelease.parse(request.body ?? request.query);
    const hold = await repo.legalHolds.get(id);
    if (!hold) throw notFound('Legal hold', id);
    if (hold.releasedAt) throw conflict('legal_hold_released', 'Legal hold was already released');
    const updated: LegalHold = {
      ...hold,
      releasedAt: now(),
      releasedBy: body.actorId,
      ...(body.reason ? { releaseReason: body.reason } : {}),
    };
    await repo.legalHolds.save(updated);
    await ctx.recordAudit({
      tenantId: hold.institutionId,
      actorId: body.actorId,
      actorType: 'admin',
      action: 'legal_hold.released',
      resourceType: 'legal_hold',
      resourceId: id,
      metadata: { scope: hold.scope, reason: body.reason ?? null },
    });
    return updated;
  });
}
