import type { FastifyInstance } from 'fastify';
import type { RetentionCandidate, RetentionTarget } from './clients.js';
import type { ServiceContext } from './context.js';
import {
  RETENTION_KINDS,
  type LegalHold,
  type RecordingPolicy,
  type RetentionJob,
  type RetentionKind,
  type RetentionKindResult,
} from './domain.js';
import { AppError, conflict, notFound } from './errors.js';
import { IdParams, RetentionJobsQuery, RetentionRun } from './schemas.js';

const DAY_MS = 86_400_000;
const DELETE_BATCH_SIZE = 500;

export function retentionDays(policy: RecordingPolicy, kind: RetentionKind): number {
  switch (kind) {
    case 'audio':
      return policy.audioRetentionDays;
    case 'transcript':
      return policy.transcriptRetentionDays;
    case 'summary':
      return policy.summaryRetentionDays;
    case 'extracted_event':
      return policy.extractedEventRetentionDays;
  }
}

/** Returns the ids of every active hold covering the candidate. */
export function matchingHolds(
  candidate: RetentionCandidate,
  kind: RetentionKind,
  holds: readonly LegalHold[],
): string[] {
  const recordingId = candidate.recordingSessionId ?? (kind === 'audio' ? candidate.id : undefined);
  return holds
    .filter((h) => {
      switch (h.scope.type) {
        case 'class_section':
          return candidate.classSectionId === h.scope.id;
        case 'recording':
          return recordingId === h.scope.id;
        case 'subject':
          return candidate.subjectIds?.includes(h.scope.id) ?? false;
      }
    })
    .map((h) => h.id);
}

const emptyResult = (): RetentionKindResult => ({
  candidates: 0,
  due: 0,
  deleted: 0,
  wouldDelete: 0,
  skippedHold: 0,
  failed: 0,
});

export interface RetentionRunInput {
  institutionId: string;
  referenceTime: Date;
  dryRun: boolean;
  requestedBy: string | null;
}

export async function runRetention(
  ctx: ServiceContext,
  input: RetentionRunInput,
): Promise<RetentionJob> {
  const { repo } = ctx;
  await ctx.requireInstitution(input.institutionId);
  const running = await repo.retentionJobs.list(
    (j) => j.institutionId === input.institutionId && j.status === 'running',
  );
  if (running.length > 0)
    throw conflict('retention_job_running', 'A retention job is already running', {
      jobId: running[0]?.id,
    });

  const policies = await repo.recordingPolicies.list(
    (p) => p.institutionId === input.institutionId,
  );
  const defaultPolicy = policies.find((p) => p.isDefault);
  if (!defaultPolicy)
    throw new AppError(422, 'no_recording_policy', 'Institution has no default recording policy');
  const policyById = new Map(policies.map((p) => [p.id, p]));
  const ref = input.referenceTime.getTime();
  const holds = await repo.legalHolds.list(
    (h) =>
      h.institutionId === input.institutionId &&
      Date.parse(h.createdAt) <= ref &&
      (h.releasedAt === undefined || Date.parse(h.releasedAt) > ref),
  );

  const job: RetentionJob = {
    id: ctx.idGenerator(),
    institutionId: input.institutionId,
    dryRun: input.dryRun,
    referenceTime: input.referenceTime.toISOString(),
    requestedBy: input.requestedBy,
    status: 'running',
    startedAt: ctx.clock.now().toISOString(),
    kinds: Object.fromEntries(RETENTION_KINDS.map((k) => [k, emptyResult()])) as Record<
      RetentionKind,
      RetentionKindResult
    >,
    holdsApplied: [],
    unconfiguredKinds: [],
    errors: [],
  };
  await repo.retentionJobs.save(job);
  const holdsApplied = new Set<string>();

  const audit = (
    action: 'retention.deleted' | 'retention.skipped_hold',
    kind: RetentionKind,
    id: string,
    metadata: Record<string, unknown>,
  ): Promise<void> =>
    ctx.recordAudit({
      tenantId: input.institutionId,
      actorId: input.requestedBy,
      actorType: input.requestedBy ? 'admin' : 'system',
      action,
      resourceType: kind,
      resourceId: id,
      metadata: { jobId: job.id, kind, ...metadata },
    });

  const processTarget = async (kind: RetentionKind, target: RetentionTarget): Promise<void> => {
    const result = job.kinds[kind];
    const minDays = Math.min(...policies.map((p) => retentionDays(p, kind)));
    const olderThan = new Date(ref - minDays * DAY_MS).toISOString();
    let candidates: RetentionCandidate[];
    try {
      candidates = await target.candidates({
        institutionId: input.institutionId,
        olderThan,
        kind,
      });
    } catch (err) {
      job.errors.push({ kind, target: target.name, message: (err as Error).message });
      return;
    }
    result.candidates += candidates.length;

    const toDelete: RetentionCandidate[] = [];
    for (const candidate of candidates) {
      const policy =
        (candidate.recordingPolicyId && policyById.get(candidate.recordingPolicyId)) ||
        defaultPolicy;
      const days = retentionDays(policy, kind);
      // Without a creation date we only know the item is older than the shortest window, so it
      // is due only when its own policy has that shortest window (conservative: keep otherwise).
      const due = candidate.createdAt
        ? Date.parse(candidate.createdAt) <= ref - days * DAY_MS
        : days <= minDays;
      if (!due) continue;
      result.due += 1;
      const holdIds = matchingHolds(candidate, kind, holds);
      if (holdIds.length > 0) {
        result.skippedHold += 1;
        holdIds.forEach((h) => holdsApplied.add(h));
        if (!input.dryRun) await audit('retention.skipped_hold', kind, candidate.id, { holdIds });
        continue;
      }
      toDelete.push(candidate);
    }

    if (input.dryRun) {
      result.wouldDelete += toDelete.length;
      return;
    }
    for (let i = 0; i < toDelete.length; i += DELETE_BATCH_SIZE) {
      const batch = toDelete.slice(i, i + DELETE_BATCH_SIZE).map((c) => c.id);
      let deletedIds: string[];
      try {
        deletedIds = await target.delete({ ids: batch, kind, jobId: job.id });
      } catch (err) {
        result.failed += batch.length;
        job.errors.push({ kind, target: target.name, message: (err as Error).message });
        continue;
      }
      const requested = new Set(batch);
      const confirmed = [...new Set(deletedIds)].filter((id) => requested.has(id));
      result.deleted += confirmed.length;
      result.failed += batch.length - confirmed.length;
      for (const id of confirmed)
        await audit('retention.deleted', kind, id, { target: target.name });
    }
  };

  try {
    for (const kind of RETENTION_KINDS) {
      const targets = ctx.retentionTargets.filter((t) => t.kinds.includes(kind));
      if (targets.length === 0) {
        job.unconfiguredKinds.push(kind);
        continue;
      }
      for (const target of targets) await processTarget(kind, target);
    }
    job.status = job.errors.length > 0 ? 'completed_with_errors' : 'completed';
  } catch (err) {
    job.status = 'failed';
    job.errors.push({ kind: 'audio', target: 'runner', message: (err as Error).message });
  }
  job.holdsApplied = [...holdsApplied];
  job.finishedAt = ctx.clock.now().toISOString();
  await repo.retentionJobs.save(job);
  await ctx.recordAudit({
    tenantId: input.institutionId,
    actorId: input.requestedBy,
    actorType: input.requestedBy ? 'admin' : 'system',
    action: 'retention.job_completed',
    resourceType: 'retention_job',
    resourceId: job.id,
    metadata: { dryRun: job.dryRun, status: job.status, kinds: job.kinds },
  });
  return job;
}

export function registerRetentionRoutes(app: FastifyInstance, ctx: ServiceContext): void {
  app.post('/v1/retention/run', async (request, reply) => {
    const body = RetentionRun.parse(request.body);
    const current = ctx.clock.now();
    if (body.now && !body.dryRun && Date.parse(body.now) > current.getTime() + 60_000) {
      // A future reference time would delete data before its retention period ends.
      throw new AppError(400, 'invalid_reference_time', '`now` may not be in the future');
    }
    const job = await runRetention(ctx, {
      institutionId: body.institutionId,
      referenceTime: body.now ? new Date(body.now) : current,
      dryRun: body.dryRun,
      requestedBy: body.actorId ?? null,
    });
    return reply.status(201).send(job);
  });

  app.get('/v1/retention/jobs', async (request) => {
    const q = RetentionJobsQuery.parse(request.query);
    const items = await ctx.repo.retentionJobs.list(
      (j) => !q.institutionId || j.institutionId === q.institutionId,
    );
    return {
      items: items.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, q.limit),
    };
  });

  app.get('/v1/retention/jobs/:id', async (request) => {
    const { id } = IdParams.parse(request.params);
    const job = await ctx.repo.retentionJobs.get(id);
    if (!job) throw notFound('Retention job', id);
    return job;
  });
}
