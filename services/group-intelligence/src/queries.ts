import type {
  AiUsage,
  AnalyticsClient,
  AiUsageClient,
  OrganizationClient,
  UsageBucket,
} from './clients.js';
import { UpstreamError } from './clients.js';
import type { CampusRef, InstitutionDaily, InstitutionRef, Provenance } from './domain.js';
import { MIN_COHORT } from './domain.js';
import {
  computeMetric,
  costByCategory,
  METRICS,
  type MetricDef,
  type MetricName,
} from './metrics.js';
import { pricingLimitations, type Pricing } from './pricing.js';
import { addDays, daysBetween, mean, periodKey, ratio, round, sum } from './stats.js';
import type { Warehouse } from './warehouse.js';

export interface QueryDeps {
  organization: OrganizationClient;
  analytics: AnalyticsClient;
  aiUsage: AiUsageClient;
  warehouse: Warehouse;
  pricing: Pricing;
  now: () => Date;
}

export interface Range {
  from: string;
  to: string;
}

const STRUCTURAL_LIMITATIONS = [
  'Dados agregados por instituição; nenhum dado individual de estudante é exibido.',
  'Contagens derivadas de estudantes abaixo de 5 pessoas são suprimidas (null).',
];

/** Caches each holding company's institution list for 5 minutes. */
export class GroupDirectory {
  private cache = new Map<string, { at: number; items: InstitutionRef[] }>();
  private campusCache = new Map<string, { at: number; items: CampusRef[] }>();

  constructor(
    private readonly org: OrganizationClient,
    private readonly now: () => Date,
    private readonly ttlMs = 300_000,
  ) {}

  async institutions(holdingCompanyId: string): Promise<InstitutionRef[]> {
    const hit = this.cache.get(holdingCompanyId);
    if (hit && this.now().getTime() - hit.at < this.ttlMs) return hit.items;
    const items = await this.org.listInstitutions(holdingCompanyId);
    this.cache.set(holdingCompanyId, { at: this.now().getTime(), items });
    return items;
  }

  async campuses(institutionId: string): Promise<CampusRef[]> {
    const hit = this.campusCache.get(institutionId);
    if (hit && this.now().getTime() - hit.at < this.ttlMs) return hit.items;
    const items = await this.org.listCampuses(institutionId);
    this.campusCache.set(institutionId, { at: this.now().getTime(), items });
    return items;
  }
}

export class GroupQueries {
  readonly directory: GroupDirectory;

  constructor(private readonly d: QueryDeps) {
    this.directory = new GroupDirectory(d.organization, d.now);
  }

  async provenance(
    institutionIds: readonly string[],
    sources: string[],
    limitations: string[] = [],
  ): Promise<Provenance> {
    return {
      sources,
      generatedAt: this.d.now().toISOString(),
      dataThrough: await this.d.warehouse.dataThrough(institutionIds),
      limitations: [...new Set([...STRUCTURAL_LIMITATIONS, ...limitations])],
    };
  }

  private async facts(institutionIds: readonly string[], r: Range): Promise<InstitutionDaily[]> {
    return this.d.warehouse.institutionDaily({ institutionIds, from: r.from, to: r.to });
  }

  private metricsFor(
    rows: readonly InstitutionDaily[],
    names: readonly MetricName[],
  ): Record<string, number | null> {
    return Object.fromEntries(names.map((n) => [n, computeMetric(n, rows)]));
  }

  /** Group-level student-derived values: sum of institution values, suppressed below 5. */
  private groupStudentValue(values: readonly (number | null)[]): number | null {
    const present = values.filter((v): v is number => v !== null);
    if (present.length === 0) return null;
    const total = sum(present);
    return total >= MIN_COHORT ? total : null;
  }

  // ---------------------------------------------------------------- 5.2 overview
  async overview(holdingCompanyId: string, r: Range): Promise<Record<string, unknown>> {
    const institutions = await this.directory.institutions(holdingCompanyId);
    const ids = institutions.map((i) => i.id);
    const rows = await this.facts(ids, r);
    const len = daysBetween(r.from, r.to) + 1;
    const previous: Range = { from: addDays(r.from, -len), to: addDays(r.from, -1) };
    const prevRows = await this.facts(ids, previous);
    const names: MetricName[] = [
      'classesScheduled',
      'classesCaptured',
      'captureRate',
      'transcriptionRate',
      'adoptionRate',
      'activeStudents',
      'deviceUptimePct',
      'incidentsOpened',
      'costPerCapturedClass',
    ];
    const trendNames: MetricName[] = ['captureRate', 'adoptionRate', 'costPerCapturedClass'];
    const trend = (cur: readonly InstitutionDaily[], prev: readonly InstitutionDaily[]) =>
      Object.fromEntries(
        trendNames.map((n) => {
          const a = computeMetric(n, cur);
          const b = computeMetric(n, prev);
          return [
            n,
            { current: a, previous: b, delta: a !== null && b !== null ? round(a - b, 4) : null },
          ];
        }),
      );
    const items = institutions.map((inst) => {
      const mine = rows.filter((x) => x.institutionId === inst.id);
      const prev = prevRows.filter((x) => x.institutionId === inst.id);
      return {
        institutionId: inst.id,
        institutionName: inst.name,
        daysOfData: new Set(mine.map((x) => x.date)).size,
        metrics: this.metricsFor(mine, names),
        trend: trend(mine, prev),
      };
    });
    const totals = this.metricsFor(
      rows,
      names.filter((n) => n !== 'activeStudents'),
    );
    totals['activeStudents'] = this.groupStudentValue(
      items.map((i) => i.metrics['activeStudents'] ?? null),
    );
    return {
      holdingCompanyId,
      from: r.from,
      to: r.to,
      previousPeriod: previous,
      institutions: items,
      totals,
      trend: trend(rows, prevRows),
      provenance: await this.provenance(
        ids,
        ['warehouse:institution_daily', 'organization:institutions'],
        [
          'Disponibilidade dos dispositivos é medida no momento de cada execução diária do pipeline.',
          ...pricingLimitations(this.d.pricing),
        ],
      ),
    };
  }

  // ---------------------------------------------------------------- 5.3 comparison
  async comparison(
    holdingCompanyId: string,
    metric: MetricName,
    r: Range,
  ): Promise<Record<string, unknown>> {
    const institutions = await this.directory.institutions(holdingCompanyId);
    const ids = institutions.map((i) => i.id);
    const rows = await this.facts(ids, r);
    const def: MetricDef = METRICS[metric];
    const limitations: string[] = [
      'Modalidade (presencial/híbrido/EAD) e calendário acadêmico não estão disponíveis para contextualizar.',
    ];
    const contexts = await Promise.all(
      institutions.map(async (inst) => {
        const mine = rows.filter((x) => x.institutionId === inst.id);
        const days = new Set(mine.map((x) => x.date)).size;
        const perDay = days > 0 ? computeMetric('classesScheduled', mine)! / days : 0;
        let campuses: number | null = null;
        try {
          campuses = (await this.directory.campuses(inst.id)).length;
        } catch {
          limitations.push(`Número de campi indisponível para ${inst.name}.`);
        }
        return {
          inst,
          value: computeMetric(metric, mine),
          daysOfData: days,
          classesPerDay: round(perDay, 1),
          sizeBand:
            perDay >= 100 ? 'large' : perDay >= 20 ? 'medium' : perDay > 0 ? 'small' : 'no_data',
          campuses,
          devicesTotal: computeMetric('devicesTotal', mine),
          firmwareCurrentPct: computeMetric('firmwareCurrentPct', mine),
        };
      }),
    );
    const maxDays = Math.max(0, ...contexts.map((c) => c.daysOfData));
    const bandRank = { no_data: -1, small: 0, medium: 1, large: 2 } as const;
    const bands = contexts
      .filter((c) => c.sizeBand !== 'no_data')
      .map((c) => bandRank[c.sizeBand as keyof typeof bandRank]);
    const medianBand =
      bands.length > 0 ? ([...bands].sort((a, b) => a - b)[Math.floor(bands.length / 2)] ?? 0) : 0;
    const items = contexts.map((c) => {
      const notes: string[] = [];
      const reasons: string[] = [];
      notes.push(
        `Porte ${c.sizeBand === 'large' ? 'grande' : c.sizeBand === 'medium' ? 'médio' : c.sizeBand === 'small' ? 'pequeno' : 'sem dados'} ` +
          `(${c.classesPerDay} aulas/dia em média).`,
      );
      if (c.campuses !== null) notes.push(`${c.campuses} campus(i).`);
      notes.push(`${c.daysOfData} dia(s) com dados no período.`);
      if (c.devicesTotal !== null) notes.push(`${c.devicesTotal} dispositivo(s) instalado(s).`);
      if (c.firmwareCurrentPct !== null && c.firmwareCurrentPct < 80)
        notes.push(`Apenas ${c.firmwareCurrentPct}% da frota no firmware mais recente.`);
      if (c.value === null) reasons.push('sem valor para a métrica no período');
      if (maxDays > 0 && c.daysOfData < maxDays * 0.5)
        reasons.push('menos da metade dos dias de dados do grupo');
      if (
        c.sizeBand !== 'no_data' &&
        Math.abs(bandRank[c.sizeBand as keyof typeof bandRank] - medianBand) >= 2
      )
        reasons.push('porte muito diferente da mediana do grupo');
      return {
        institutionId: c.inst.id,
        institutionName: c.inst.name,
        value: c.value,
        comparable: reasons.length === 0,
        notComparableReasons: reasons,
        contextNotes: notes,
      };
    });
    const ranked = [...items].sort((a, b) => {
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      return def.higherIsBetter ? b.value - a.value : a.value - b.value;
    });
    if (def.studentDerived)
      limitations.push(
        'Métrica derivada de estudantes: instituições com menos de 5 estudantes ativos aparecem como null.',
      );
    return {
      holdingCompanyId,
      metric,
      metricLabel: def.label,
      unit: def.unit,
      higherIsBetter: def.higherIsBetter,
      from: r.from,
      to: r.to,
      institutions: ranked.map((x, i) => ({ rank: x.value === null ? null : i + 1, ...x })),
      provenance: await this.provenance(
        ids,
        ['warehouse:institution_daily', 'organization:campuses'],
        limitations,
      ),
    };
  }

  // ---------------------------------------------------------------- 5.4 academic indicators (live)
  async academicIndicators(holdingCompanyId: string, r: Range): Promise<Record<string, unknown>> {
    const institutions = await this.directory.institutions(holdingCompanyId);
    const limitations: string[] = [
      'Indicadores acadêmicos são calculados ao vivo a partir do academic-analytics para o período.',
      'Cobertura de ementa considera até 30 disciplinas com ementa cadastrada por instituição.',
    ];
    const a = this.d.analytics;
    const items = await Promise.all(
      institutions.map(async (inst) => {
        try {
          const [adoption, summaries, assessments, conflicts] = await Promise.all([
            a.adoption(inst.id, r.from, r.to),
            a.reportSummaries(inst.id, r.from, r.to),
            a.assessmentTotals(inst.id, r.from, r.to),
            a.conflictCount(inst.id, r.from, r.to),
          ]);
          const courseIds = [
            ...new Set(
              adoption.sections.map((s) => s.courseId).filter((c): c is string => c !== null),
            ),
          ].slice(0, 30);
          const ratios = (await Promise.all(courseIds.map((c) => a.courseCoverageRatio(c)))).filter(
            (v): v is number => v !== null,
          );
          const c = summaries.corrections;
          return {
            institutionId: inst.id,
            institutionName: inst.name,
            indicators: {
              syllabusCoverageRatio: mean(ratios),
              coursesWithSyllabus: ratios.length,
              assessmentLoadIndex:
                assessments.days > 0 ? round(assessments.assessments / assessments.days, 2) : null,
              maxDailyAssessmentLoad: assessments.maxDailyLoad,
              conflictRate: ratio(conflicts, assessments.assessments),
              eventReviewLatencyP50Minutes: adoption.totals.medianReviewLatencyMinutes,
              eventCorrectionRate: ratio(c.eventEdits + c.eventRejections, c.eventsExtracted),
              transcriptCorrectionsPerClass: ratio(
                c.transcriptSegmentsCorrected,
                summaries.transcription.transcribed,
              ),
            },
            error: null,
          };
        } catch (err) {
          const message = err instanceof UpstreamError ? err.message : String(err);
          limitations.push(`Indicadores indisponíveis para ${inst.name}: ${message}.`);
          return {
            institutionId: inst.id,
            institutionName: inst.name,
            indicators: null,
            error: 'upstream_unavailable',
          };
        }
      }),
    );
    return {
      holdingCompanyId,
      from: r.from,
      to: r.to,
      institutions: items,
      provenance: await this.provenance(
        institutions.map((i) => i.id),
        [
          'academic-analytics:adoption',
          'academic-analytics:reports',
          'academic-analytics:assessments',
          'academic-analytics:coverage',
        ],
        limitations,
      ),
    };
  }

  // ---------------------------------------------------------------- 5.5 operations
  async operations(holdingCompanyId: string, r: Range): Promise<Record<string, unknown>> {
    const institutions = await this.directory.institutions(holdingCompanyId);
    const ids = institutions.map((i) => i.id);
    const rows = await this.facts(ids, r);
    const costs = await this.d.warehouse.costDaily({ institutionIds: ids, from: r.from, to: r.to });
    const names: MetricName[] = [
      'devicesTotal',
      'deviceUptimePct',
      'firmwareCurrentPct',
      'incidentsOpened',
      'incidentsPer100Classes',
      'mttrMinutes',
      'classesCaptured',
      'totalCostUsd',
      'costPerCapturedClass',
    ];
    const perClass = (
      amounts: Record<string, number>,
      captured: number,
    ): Record<string, number | null> =>
      Object.fromEntries(
        Object.entries(amounts).map(([k, v]) => [k, captured > 0 ? round(v / captured, 4) : null]),
      );
    const items = institutions.map((inst) => {
      const mine = rows.filter((x) => x.institutionId === inst.id);
      const byCategory = costByCategory(costs.filter((c) => c.institutionId === inst.id));
      const captured = computeMetric('classesCaptured', mine) ?? 0;
      return {
        institutionId: inst.id,
        institutionName: inst.name,
        metrics: this.metricsFor(mine, names),
        costByCategoryUsd: byCategory,
        costPerCapturedClassByCategoryUsd: perClass(byCategory, captured),
      };
    });
    const byCategory = costByCategory(costs);
    return {
      holdingCompanyId,
      from: r.from,
      to: r.to,
      institutions: items,
      totals: {
        ...this.metricsFor(rows, names),
        costByCategoryUsd: byCategory,
        costPerCapturedClassByCategoryUsd: perClass(
          byCategory,
          computeMetric('classesCaptured', rows) ?? 0,
        ),
      },
      provenance: await this.provenance(
        ids,
        ['warehouse:institution_daily', 'warehouse:cost_daily'],
        [
          'Custo por aula capturada = (IA + STT + armazenamento + computação + amortização de hardware) / aulas capturadas.',
          ...pricingLimitations(this.d.pricing),
        ],
      ),
    };
  }

  // ---------------------------------------------------------------- 5.8 adoption time series
  async adoption(
    holdingCompanyId: string,
    granularity: 'week' | 'month',
    r: Range,
  ): Promise<Record<string, unknown>> {
    const institutions = await this.directory.institutions(holdingCompanyId);
    const ids = institutions.map((i) => i.id);
    const rows = await this.facts(ids, r);
    const names: MetricName[] = [
      'classesCaptured',
      'captureRate',
      'adoptionRate',
      'reviewRate',
      'activeStudents',
      'assistantQuestions',
    ];
    const series = institutions.map((inst) => {
      const mine = rows.filter((x) => x.institutionId === inst.id);
      const periods = [...new Set(mine.map((x) => periodKey(x.date, granularity)))].sort();
      return {
        institutionId: inst.id,
        institutionName: inst.name,
        points: periods.map((p) => ({
          period: p,
          ...this.metricsFor(
            mine.filter((x) => periodKey(x.date, granularity) === p),
            names,
          ),
        })),
      };
    });
    return {
      holdingCompanyId,
      granularity,
      from: r.from,
      to: r.to,
      series,
      provenance: await this.provenance(ids, ['warehouse:institution_daily']),
    };
  }

  // ---------------------------------------------------------------- 5.9 costs
  async costs(
    holdingCompanyId: string,
    groupBy: 'institution' | 'campus' | 'category',
    r: Range,
  ): Promise<Record<string, unknown>> {
    const institutions = await this.directory.institutions(holdingCompanyId);
    const ids = institutions.map((i) => i.id);
    const q = { institutionIds: ids, from: r.from, to: r.to };
    const costs = await this.d.warehouse.costDaily(q);
    const limitations = [...pricingLimitations(this.d.pricing)];
    let rows: Record<string, unknown>[] = [];
    if (groupBy === 'category') {
      rows = Object.entries(costByCategory(costs)).map(([category, amountUsd]) => ({
        category,
        amountUsd,
      }));
    } else if (groupBy === 'institution') {
      const facts = await this.facts(ids, r);
      rows = institutions.map((inst) => {
        const mine = costs.filter((c) => c.institutionId === inst.id);
        const amount = round(sum(mine.map((c) => c.amountUsd)), 4);
        const captured =
          computeMetric(
            'classesCaptured',
            facts.filter((f) => f.institutionId === inst.id),
          ) ?? 0;
        return {
          institutionId: inst.id,
          institutionName: inst.name,
          amountUsd: amount,
          byCategoryUsd: costByCategory(mine),
          classesCaptured: captured,
          costPerCapturedClass: captured > 0 ? round(amount / captured, 4) : null,
        };
      });
    } else {
      const campusFacts = await this.d.warehouse.campusDaily(q);
      const names = new Map<string, string>();
      for (const inst of institutions) {
        try {
          for (const c of await this.directory.campuses(inst.id)) names.set(c.id, c.name);
        } catch {
          limitations.push(`Nomes de campi indisponíveis para ${inst.name}.`);
        }
      }
      const keys = new Set(costs.map((c) => `${c.institutionId}|${c.campusId ?? ''}`));
      rows = [...keys].map((key) => {
        const [institutionId, campusId] = key.split('|');
        const mine = costs.filter(
          (c) => c.institutionId === institutionId && (c.campusId ?? '') === campusId,
        );
        const amount = round(sum(mine.map((c) => c.amountUsd)), 4);
        const captured = campusId
          ? sum(campusFacts.filter((f) => f.campusId === campusId).map((f) => f.classesCaptured))
          : null;
        return {
          institutionId,
          institutionName: institutions.find((i) => i.id === institutionId)?.name ?? null,
          campusId: campusId || null,
          campusName: campusId
            ? (names.get(campusId) ?? null)
            : 'Nível institucional (não atribuído a campus)',
          amountUsd: amount,
          byCategoryUsd: costByCategory(mine),
          classesCaptured: captured,
          costPerCapturedClass: captured ? round(amount / captured, 4) : null,
        };
      });
      limitations.push(
        'Custos de IA e computação são registrados no nível da instituição, não do campus.',
      );
    }
    return {
      holdingCompanyId,
      groupBy,
      from: r.from,
      to: r.to,
      totalUsd: round(sum(costs.map((c) => c.amountUsd)), 4),
      rows,
      provenance: await this.provenance(
        ids,
        ['warehouse:cost_daily', 'warehouse:campus_daily'],
        limitations,
      ),
    };
  }

  // ---------------------------------------------------------------- 5.10 AI usage (live)
  async aiUsage(holdingCompanyId: string, r: Range): Promise<Record<string, unknown>> {
    const institutions = await this.directory.institutions(holdingCompanyId);
    const limitations: string[] = ['Uso de IA consultado ao vivo no ai-gateway (UTC).'];
    const fromIso = `${r.from}T00:00:00.000Z`;
    const toIso = `${addDays(r.to, 1)}T00:00:00.000Z`;
    const results = await Promise.all(
      institutions.map(async (inst) => {
        try {
          return { inst, usage: await this.d.aiUsage.usage(inst.id, fromIso, toIso) };
        } catch (err) {
          limitations.push(
            `Uso de IA indisponível para ${inst.name}: ${err instanceof Error ? err.message : String(err)}.`,
          );
          return { inst, usage: null };
        }
      }),
    );
    const merge = (
      key: keyof Pick<AiUsage, 'byTask' | 'byModel' | 'byPromptVersion'>,
    ): UsageBucket[] => {
      const m = new Map<string, UsageBucket>();
      for (const { usage } of results)
        for (const b of usage?.[key] ?? []) {
          const cur = m.get(b.key) ?? {
            key: b.key,
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
          };
          cur.calls += b.calls;
          cur.inputTokens += b.inputTokens;
          cur.outputTokens += b.outputTokens;
          cur.costUsd = round(cur.costUsd + b.costUsd, 6);
          m.set(b.key, cur);
        }
      return [...m.values()].sort((a, b) => b.costUsd - a.costUsd);
    };
    const totalCost = round(sum(results.map((x) => x.usage?.totals.costUsd ?? 0)), 6);
    return {
      holdingCompanyId,
      from: r.from,
      to: r.to,
      totals: {
        calls: sum(results.map((x) => x.usage?.totals.calls ?? 0)),
        inputTokens: sum(results.map((x) => x.usage?.totals.inputTokens ?? 0)),
        outputTokens: sum(results.map((x) => x.usage?.totals.outputTokens ?? 0)),
        costUsd: totalCost,
      },
      byInstitution: results.map(({ inst, usage }) => ({
        institutionId: inst.id,
        institutionName: inst.name,
        ...(usage?.totals ?? { calls: null, inputTokens: null, outputTokens: null, costUsd: null }),
        shareOfCost: usage && totalCost > 0 ? round(usage.totals.costUsd / totalCost, 4) : null,
      })),
      byTask: merge('byTask'),
      byModel: merge('byModel'),
      byPromptVersion: merge('byPromptVersion'),
      provenance: await this.provenance(
        institutions.map((i) => i.id),
        ['ai-gateway:/v1/usage'],
        limitations,
      ),
    };
  }

  // ---------------------------------------------------------------- tool primitives (investigation)
  async metricByInstitution(
    holdingCompanyId: string,
    metric: MetricName,
    r: Range,
  ): Promise<Record<string, unknown>[]> {
    const institutions = await this.directory.institutions(holdingCompanyId);
    const rows = await this.facts(
      institutions.map((i) => i.id),
      r,
    );
    return institutions.map((inst) => ({
      institutionId: inst.id,
      institutionName: inst.name,
      value: computeMetric(
        metric,
        rows.filter((x) => x.institutionId === inst.id),
      ),
    }));
  }

  async metricTimeseries(
    holdingCompanyId: string,
    metric: MetricName,
    granularity: 'day' | 'week' | 'month',
    r: Range,
    institutionId: string | null,
  ): Promise<Record<string, unknown>[]> {
    const institutions = await this.directory.institutions(holdingCompanyId);
    const ids = institutionId ? [institutionId] : institutions.map((i) => i.id);
    const rows = await this.facts(ids, r);
    const periods = [...new Set(rows.map((x) => periodKey(x.date, granularity)))].sort();
    return periods.map((p) => ({
      period: p,
      institutionId,
      value: computeMetric(
        metric,
        rows.filter((x) => periodKey(x.date, granularity) === p),
      ),
    }));
  }

  async costBreakdown(
    holdingCompanyId: string,
    groupBy: 'institution' | 'campus' | 'category',
    r: Range,
  ): Promise<Record<string, unknown>[]> {
    const res = await this.costs(holdingCompanyId, groupBy, r);
    return (res['rows'] as Record<string, unknown>[]).map((row) => {
      return Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'byCategoryUsd'));
    });
  }

  async comparePeriods(
    holdingCompanyId: string,
    metric: MetricName,
    a: Range,
    b: Range,
  ): Promise<Record<string, unknown>[]> {
    const [ra, rb] = await Promise.all([
      this.metricByInstitution(holdingCompanyId, metric, a),
      this.metricByInstitution(holdingCompanyId, metric, b),
    ]);
    return ra.map((x, i) => {
      const va = x['value'] as number | null;
      const vb = (rb[i]?.['value'] as number | null | undefined) ?? null;
      return {
        institutionId: x['institutionId'],
        institutionName: x['institutionName'],
        a: va,
        b: vb,
        delta: va !== null && vb !== null ? round(vb - va, 4) : null,
      };
    });
  }
}
