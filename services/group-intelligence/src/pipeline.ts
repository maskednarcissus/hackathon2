import { randomUUID } from 'node:crypto';
import type {
  AdoptionSection,
  AiUsageClient,
  AnalyticsClient,
  DeviceClient,
  IncidentsClient,
  OrganizationClient,
} from './clients.js';
import { onlineDevices, UpstreamError } from './clients.js';
import {
  MIN_COHORT,
  type CampusDaily,
  type CostDaily,
  type InstitutionDaily,
  type InstitutionRef,
  type PipelineRun,
} from './domain.js';
import { daysInMonth, hardwareDailyCost, storageCost, sttCost, type Pricing } from './pricing.js';
import { addDays, round, sum } from './stats.js';
import type { Warehouse } from './warehouse.js';

export interface Sources {
  organization: OrganizationClient;
  analytics: AnalyticsClient;
  aiUsage: AiUsageClient;
  devices: DeviceClient;
  incidents: IncidentsClient;
}

export interface PipelineDeps {
  sources: Sources;
  warehouse: Warehouse;
  pricing: Pricing;
  now: () => Date;
}

/**
 * Student-derived engagement for one institution-day. Applied at build time:
 * - sections the upstream suppressed, or whose cohort is below MIN_COHORT, are dropped (defence in
 *   depth — analytics already suppresses them);
 * - if fewer than MIN_COHORT students remain in total, all three values are null.
 * Students active in several sections are counted once per section (upstream exposes no ids).
 */
export function engagementAggregate(sections: readonly AdoptionSection[]): {
  activeStudents: number | null;
  assistantQuestions: number | null;
  searches: number | null;
} {
  const eligible = sections.filter(
    (s) =>
      !s.engagement.suppressed &&
      (s.engagement.cohortSize ?? 0) >= MIN_COHORT &&
      (s.engagement.activeStudents ?? 0) >= MIN_COHORT,
  );
  const active = sum(eligible.map((s) => s.engagement.activeStudents ?? 0));
  if (active < MIN_COHORT)
    return { activeStudents: null, assistantQuestions: null, searches: null };
  return {
    activeStudents: active,
    assistantQuestions: sum(eligible.map((s) => s.engagement.assistantQuestions ?? 0)),
    searches: sum(eligible.map((s) => s.engagement.searches ?? 0)),
  };
}

type RunError = PipelineRun['errors'][number];

async function settle<T>(
  errors: RunError[],
  institutionId: string | null,
  source: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    errors.push({
      institutionId,
      source,
      message: err instanceof UpstreamError ? err.message : String(err),
    });
    return null;
  }
}

async function buildInstitution(
  deps: PipelineDeps,
  inst: InstitutionRef,
  date: string,
  errors: RunError[],
): Promise<{ institution: InstitutionDaily; campuses: CampusDaily[]; costs: CostDaily[] } | null> {
  const { sources, pricing } = deps;
  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd = `${addDays(date, 1)}T00:00:00.000Z`;
  const [capture, adoption, usage, fleet, incidents, allocations] = await Promise.all([
    settle(errors, inst.id, 'academic-analytics:capture-coverage', () =>
      sources.analytics.captureCoverage(inst.id, date, date),
    ),
    settle(errors, inst.id, 'academic-analytics:adoption', () =>
      sources.analytics.adoption(inst.id, date, date),
    ),
    settle(errors, inst.id, 'ai-gateway:usage', () =>
      sources.aiUsage.usage(inst.id, dayStart, dayEnd),
    ),
    settle(errors, inst.id, 'device-management:fleet', () => sources.devices.fleet(inst.id)),
    settle(errors, inst.id, 'notifications:incidents-stats', () =>
      sources.incidents.stats(inst.id, dayStart, dayEnd),
    ),
    deps.warehouse.allocations([inst.id], date.slice(0, 7)),
  ]);
  // Without the academic facts the day is meaningless: skip it rather than store zeros.
  if (capture === null || adoption === null) return null;

  const builtAt = deps.now().toISOString();
  const t = adoption.totals;
  const engagement = engagementAggregate(adoption.sections);
  const devicesTotal = fleet?.total ?? 0;
  const devicesOnline = fleet ? onlineDevices(fleet) : 0;

  const stt = sttCost(pricing, t.classesTranscribed);
  const storage = storageCost(pricing, t.classesCaptured);
  const hardware = hardwareDailyCost(pricing, devicesTotal, date);
  const compute = round(sum(allocations.map((a) => a.amountUsd)) / daysInMonth(date), 6);
  const ai = round(usage?.totals.costUsd ?? 0, 6);

  const base = { holdingCompanyId: inst.holdingCompanyId, institutionId: inst.id, date };
  const costs: CostDaily[] = [
    { ...base, campusId: null, category: 'ai', amountUsd: ai, source: 'ai-gateway:/v1/usage' },
    {
      ...base,
      campusId: null,
      category: 'compute',
      amountUsd: compute,
      source: 'cost-allocations',
    },
  ];

  // Campus rows: capture from the capture-coverage report, devices from the fleet console.
  const campusIds = new Set<string>([
    ...capture.map((r) => r.campusId).filter((c): c is string => c !== null),
    ...(fleet?.byCampus.map((c) => c.campusId) ?? []),
  ]);
  const campuses: CampusDaily[] = [...campusIds].map((campusId) => {
    const rows = capture.filter((r) => r.campusId === campusId);
    const dev = fleet?.byCampus.find((c) => c.campusId === campusId);
    const captured = sum(rows.map((r) => r.captured));
    return {
      ...base,
      campusId,
      classesScheduled: sum(rows.map((r) => r.scheduled)),
      classesCaptured: captured,
      devicesTotal: dev?.total ?? 0,
      devicesOnline: dev?.online ?? 0,
      // Transcription is attributed to campuses in proportion to captured classes.
      sttCostUsd: round(t.classesCaptured > 0 ? (stt * captured) / t.classesCaptured : 0, 6),
      storageCostUsd: storageCost(pricing, captured),
      hardwareCostUsd: hardwareDailyCost(pricing, dev?.total ?? 0, date),
      builtAt,
    };
  });
  const attributedStt = sum(campuses.map((c) => c.sttCostUsd));
  const attributedStorage = sum(campuses.map((c) => c.storageCostUsd));
  const attributedHardware = sum(campuses.map((c) => c.hardwareCostUsd));
  for (const c of campuses) {
    costs.push(
      {
        ...base,
        campusId: c.campusId,
        category: 'stt',
        amountUsd: c.sttCostUsd,
        source: 'pricing:sttUsdPerMinute',
      },
      {
        ...base,
        campusId: c.campusId,
        category: 'storage',
        amountUsd: c.storageCostUsd,
        source: 'pricing:storageUsdPerGbMonth',
      },
      {
        ...base,
        campusId: c.campusId,
        category: 'hardware',
        amountUsd: c.hardwareCostUsd,
        source: 'pricing:deviceAmortisation',
      },
    );
  }
  // Whatever could not be attributed to a campus stays at institution level.
  const residual = (total: number, attributed: number): number =>
    round(Math.max(0, total - attributed), 6);
  const leftovers: [CostDaily['category'], number, string][] = [
    ['stt', residual(stt, attributedStt), 'pricing:sttUsdPerMinute'],
    ['storage', residual(storage, attributedStorage), 'pricing:storageUsdPerGbMonth'],
    ['hardware', residual(hardware, attributedHardware), 'pricing:deviceAmortisation'],
  ];
  for (const [category, amountUsd, source] of leftovers)
    if (amountUsd > 0) costs.push({ ...base, campusId: null, category, amountUsd, source });

  const institution: InstitutionDaily = {
    ...base,
    classesScheduled: t.classesScheduled,
    classesCaptured: t.classesCaptured,
    classesTranscribed: t.classesTranscribed,
    classesStructured: t.classesStructured,
    eventsExtracted: t.eventsExtracted,
    eventsReviewed: t.eventsReviewed,
    professorsTeaching: adoption.professors.filter((p) => p.classesScheduled > 0).length,
    activeProfessors: adoption.professors.filter((p) => p.eventsReviewed > 0).length,
    ...engagement,
    devicesTotal,
    devicesOnline,
    // Point-in-time availability at pipeline run (device-management keeps no daily history).
    deviceUptimePct: devicesTotal > 0 ? round((devicesOnline / devicesTotal) * 100, 1) : null,
    firmwareCurrentPct: fleet?.firmwareCurrentPct ?? null,
    incidentsOpened: incidents?.raised ?? 0,
    incidentsResolved: incidents?.resolved ?? 0,
    mttrMinutes: incidents?.mttrMinutes ?? null,
    aiCostUsd: ai,
    sttCostUsd: stt,
    storageCostUsd: storage,
    infraCostUsd: round(compute + hardware, 6),
    builtAt,
  };
  return { institution, campuses, costs };
}

/** Builds the group fact tables for `date` (§3), replacing any previous build of that date. */
export async function runPipeline(
  deps: PipelineDeps,
  date: string,
  holdingCompanyIds: readonly string[],
): Promise<PipelineRun> {
  const startedAt = deps.now().toISOString();
  const errors: RunError[] = [];
  let built = 0;
  for (const hc of holdingCompanyIds) {
    const institutions = await settle(errors, null, 'organization:institutions', () =>
      deps.sources.organization.listInstitutions(hc),
    );
    if (!institutions) continue;
    const results = await Promise.all(
      institutions.map((inst) => buildInstitution(deps, inst, date, errors)),
    );
    const ok = results.filter((r): r is NonNullable<typeof r> => r !== null);
    // Only replace institutions that were rebuilt; a failed upstream keeps the previous build.
    await deps.warehouse.replaceDay(
      date,
      ok.map((r) => r.institution.institutionId),
      {
        institutions: ok.map((r) => r.institution),
        campuses: ok.flatMap((r) => r.campuses),
        costs: ok.flatMap((r) => r.costs),
      },
    );
    built += ok.length;
  }
  const run: PipelineRun = {
    id: randomUUID(),
    date,
    holdingCompanyIds: [...holdingCompanyIds],
    status: errors.length === 0 ? 'completed' : built > 0 ? 'completed_with_errors' : 'failed',
    startedAt,
    finishedAt: deps.now().toISOString(),
    institutions: built,
    errors,
  };
  await deps.warehouse.saveRun(run);
  return run;
}
