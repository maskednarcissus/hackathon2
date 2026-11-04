import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Authenticator, type AuthConfig } from './auth.js';
import { UpstreamError, type GatewayClient } from './clients.js';
import type { CostAllocation } from './domain.js';
import { HttpError, installErrorHandler } from './errors.js';
import { investigate } from './investigation.js';
import { isMetric, METRIC_NAMES, metricCatalogue } from './metrics.js';
import { runPipeline, type Sources } from './pipeline.js';
import type { Pricing } from './pricing.js';
import { GroupQueries, type Range } from './queries.js';
import { addDays, daysBetween } from './stats.js';
import type { Warehouse } from './warehouse.js';

export interface Clock {
  now(): Date;
}

export interface GroupDeps {
  sources: Sources;
  gateway: GatewayClient;
  warehouse: Warehouse;
  pricing: Pricing;
  auth: AuthConfig;
  clock?: Clock;
  /** Holding companies the scheduled pipeline builds when a run names none (GROUP_HOLDING_COMPANY_IDS). */
  defaultHoldingCompanyIds?: string[];
  /** Institution billed for investigation AI calls (gateway budgets are per institution). */
  investigationBillingInstitutionId?: string;
  logger?: boolean;
}

const MAX_RANGE_DAYS = 366;
const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const GroupParams = z.object({ id: uuid });

export function buildApp(deps: GroupDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 256 * 1024 });
  const clock: Clock = deps.clock ?? { now: () => new Date() };
  const auth = new Authenticator(deps.auth);
  const queries = new GroupQueries({
    organization: deps.sources.organization,
    analytics: deps.sources.analytics,
    aiUsage: deps.sources.aiUsage,
    warehouse: deps.warehouse,
    pricing: deps.pricing,
    now: () => clock.now(),
  });
  const yesterday = (): string => addDays(clock.now().toISOString().slice(0, 10), -1);

  installErrorHandler(app, (err) =>
    err instanceof UpstreamError
      ? new HttpError(502, 'upstream_unavailable', err.message, { service: err.service })
      : null,
  );

  function range(query: unknown, defaultDays = 30): Range {
    const q = z.object({ from: date.optional(), to: date.optional() }).passthrough().parse(query);
    const to = q.to ?? yesterday();
    const from = q.from ?? addDays(to, -(defaultDays - 1));
    if (to < from) throw new HttpError(400, 'invalid_range', '`to` must be on or after `from`');
    if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS)
      throw new HttpError(400, 'invalid_range', `range may not exceed ${MAX_RANGE_DAYS} days`);
    return { from, to };
  }

  async function group(req: { params: unknown }): Promise<string> {
    return GroupParams.parse(req.params).id;
  }

  app.get('/health', () => ({ status: 'ok', service: 'group-intelligence' }));

  app.get('/v1/metrics', () => ({ metrics: metricCatalogue() }));

  // ---------------------------------------------------------------- 5.7 pipeline
  app.post('/v1/pipeline/run', async (req) => {
    auth.operator(req);
    const body = z
      .object({ date: date.optional(), holdingCompanyId: uuid.optional() })
      .default({})
      .parse(req.body ?? {});
    const day = body.date ?? yesterday();
    if (day > clock.now().toISOString().slice(0, 10))
      throw new HttpError(422, 'future_date', 'Cannot build facts for a future date');
    const hcs = body.holdingCompanyId
      ? [body.holdingCompanyId]
      : (deps.defaultHoldingCompanyIds ?? []);
    if (hcs.length === 0)
      throw new HttpError(
        422,
        'no_holding_company',
        'holdingCompanyId required (no GROUP_HOLDING_COMPANY_IDS configured)',
      );
    return runPipeline(
      {
        sources: deps.sources,
        warehouse: deps.warehouse,
        pricing: deps.pricing,
        now: () => clock.now(),
      },
      day,
      hcs,
    );
  });

  app.get('/v1/pipeline/runs', async (req) => {
    auth.operator(req);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
      .parse(req.query);
    return { items: await deps.warehouse.listRuns(limit) };
  });

  // ---------------------------------------------------------------- cost allocations (compute)
  const AllocationBody = z.object({
    institutionId: uuid,
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM'),
    amountUsd: z.number().nonnegative().max(10_000_000),
    note: z.string().trim().max(500).optional(),
  });

  app.post('/v1/groups/:id/cost-allocations', async (req, reply) => {
    const hc = await group(req);
    await auth.groupReader(req, hc);
    const body = AllocationBody.parse(req.body);
    const institutions = await queries.directory.institutions(hc);
    if (!institutions.some((i) => i.id === body.institutionId))
      throw new HttpError(
        422,
        'institution_not_in_group',
        'Institution does not belong to this holding company',
      );
    const allocation: CostAllocation = {
      id: randomUUID(),
      holdingCompanyId: hc,
      institutionId: body.institutionId,
      month: body.month,
      category: 'compute',
      amountUsd: body.amountUsd,
      note: body.note ?? null,
      createdAt: clock.now().toISOString(),
    };
    await deps.warehouse.addAllocation(allocation);
    return reply.status(201).send(allocation);
  });

  app.get('/v1/groups/:id/cost-allocations', async (req) => {
    const hc = await group(req);
    await auth.groupReader(req, hc);
    return { items: await deps.warehouse.listAllocations(hc) };
  });

  // ---------------------------------------------------------------- 5.2–5.5, 5.8–5.10
  app.get('/v1/groups/:id/overview', async (req) => {
    const hc = await group(req);
    await auth.groupReader(req, hc);
    return queries.overview(hc, range(req.query));
  });

  app.get('/v1/groups/:id/comparison', async (req) => {
    const hc = await group(req);
    await auth.groupReader(req, hc);
    const { metric } = z
      .object({ metric: z.string().default('captureRate') })
      .passthrough()
      .parse(req.query);
    if (!isMetric(metric))
      throw new HttpError(
        400,
        'unknown_metric',
        `metric must be one of: ${METRIC_NAMES.join(', ')}`,
      );
    return queries.comparison(hc, metric, range(req.query));
  });

  app.get('/v1/groups/:id/academic-indicators', async (req) => {
    const hc = await group(req);
    await auth.groupReader(req, hc);
    // academic-analytics accepts at most 186 days per call.
    const r = range(req.query);
    if (daysBetween(r.from, r.to) + 1 > 186)
      throw new HttpError(
        400,
        'invalid_range',
        'academic indicators range may not exceed 186 days',
      );
    return queries.academicIndicators(hc, r);
  });

  app.get('/v1/groups/:id/operations', async (req) => {
    const hc = await group(req);
    await auth.groupReader(req, hc);
    return queries.operations(hc, range(req.query));
  });

  app.get('/v1/groups/:id/adoption', async (req) => {
    const hc = await group(req);
    await auth.groupReader(req, hc);
    const { granularity } = z
      .object({ granularity: z.enum(['week', 'month']).default('week') })
      .passthrough()
      .parse(req.query);
    return queries.adoption(hc, granularity, range(req.query, 90));
  });

  app.get('/v1/groups/:id/costs', async (req) => {
    const hc = await group(req);
    await auth.groupReader(req, hc);
    const { groupBy } = z
      .object({ groupBy: z.enum(['institution', 'campus', 'category']).default('institution') })
      .passthrough()
      .parse(req.query);
    return queries.costs(hc, groupBy, range(req.query));
  });

  app.get('/v1/groups/:id/ai-usage', async (req) => {
    const hc = await group(req);
    await auth.groupReader(req, hc);
    return queries.aiUsage(hc, range(req.query));
  });

  // ---------------------------------------------------------------- 5.6 investigations
  app.post('/v1/groups/:id/investigations', async (req) => {
    const hc = await group(req);
    await auth.groupReader(req, hc);
    const body = z.object({ question: z.string().trim().min(3).max(1000) }).parse(req.body);
    const institutions = await queries.directory.institutions(hc);
    if (institutions.length === 0)
      throw new HttpError(404, 'group_not_found', 'No institutions found for this holding company');
    const billing = deps.investigationBillingInstitutionId ?? institutions[0]?.id ?? '';
    const defaultRange = range({});
    const result = await investigate(
      { gateway: deps.gateway, queries, now: () => clock.now() },
      hc,
      body.question,
      institutions,
      billing,
      defaultRange,
    );
    const ids = institutions.map((i) => i.id);
    const sources = [
      ...new Set(
        result.queriesRun.map((q) =>
          q.tool === 'cost_breakdown' ? 'warehouse:cost_daily' : 'warehouse:institution_daily',
        ),
      ),
      'ai-gateway:/v1/generate',
    ];
    return {
      holdingCompanyId: hc,
      question: body.question,
      ...result,
      provenance: await queries.provenance(ids, sources, [
        'Respostas são geradas por IA a partir das consultas listadas em queriesRun; números sem suporte são removidos.',
        ...result.limitations,
      ]),
    };
  });

  return app;
}
