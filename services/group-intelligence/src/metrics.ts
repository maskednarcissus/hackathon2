import type { CostDaily, InstitutionDaily } from './domain.js';
import { MIN_COHORT } from './domain.js';
import { mean, ratio, round, sum, sumNullable, weightedMean } from './stats.js';

export interface MetricDef {
  label: string;
  unit: 'ratio' | 'count' | 'percent' | 'usd' | 'minutes';
  higherIsBetter: boolean;
  /** True when the metric is derived from student activity (cohort rule applies). */
  studentDerived?: boolean;
  compute: (rows: readonly InstitutionDaily[]) => number | null;
}

const total = (rows: readonly InstitutionDaily[], k: keyof InstitutionDaily): number =>
  sum(rows.map((r) => (typeof r[k] === 'number' ? r[k] : 0)));

const latest = (
  rows: readonly InstitutionDaily[],
  k: 'devicesTotal' | 'firmwareCurrentPct',
): number | null => {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const v = sorted[i]?.[k];
    if (typeof v === 'number') return v;
  }
  return null;
};

export const totalCost = (rows: readonly InstitutionDaily[]): number =>
  round(sum(rows.map((r) => r.aiCostUsd + r.sttCostUsd + r.storageCostUsd + r.infraCostUsd)), 4);

/**
 * Active students over a period = the busiest day's value (daily values cannot be summed — the
 * same student is active on many days). Below MIN_COHORT the value is suppressed.
 */
function activeStudents(rows: readonly InstitutionDaily[]): number | null {
  const values = rows.map((r) => r.activeStudents).filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  const max = Math.max(...values);
  return max >= MIN_COHORT ? max : null;
}

export const METRICS = {
  classesScheduled: {
    label: 'Aulas programadas',
    unit: 'count',
    higherIsBetter: true,
    compute: (r) => total(r, 'classesScheduled'),
  },
  classesCaptured: {
    label: 'Aulas capturadas',
    unit: 'count',
    higherIsBetter: true,
    compute: (r) => total(r, 'classesCaptured'),
  },
  captureRate: {
    label: 'Taxa de captura',
    unit: 'ratio',
    higherIsBetter: true,
    compute: (r) => ratio(total(r, 'classesCaptured'), total(r, 'classesScheduled')),
  },
  transcriptionRate: {
    label: 'Taxa de transcrição',
    unit: 'ratio',
    higherIsBetter: true,
    compute: (r) => ratio(total(r, 'classesTranscribed'), total(r, 'classesCaptured')),
  },
  structuringRate: {
    label: 'Taxa de estruturação de aulas',
    unit: 'ratio',
    higherIsBetter: true,
    compute: (r) => ratio(total(r, 'classesStructured'), total(r, 'classesTranscribed')),
  },
  reviewRate: {
    label: 'Taxa de revisão de eventos',
    unit: 'ratio',
    higherIsBetter: true,
    compute: (r) => ratio(total(r, 'eventsReviewed'), total(r, 'eventsExtracted')),
  },
  adoptionRate: {
    label: 'Adoção docente (professor-dia com revisão / professor-dia lecionando)',
    unit: 'ratio',
    higherIsBetter: true,
    compute: (r) => ratio(total(r, 'activeProfessors'), total(r, 'professorsTeaching')),
  },
  activeStudents: {
    label: 'Estudantes ativos (dia de pico)',
    unit: 'count',
    higherIsBetter: true,
    studentDerived: true,
    compute: activeStudents,
  },
  assistantQuestions: {
    label: 'Perguntas ao assistente',
    unit: 'count',
    higherIsBetter: true,
    studentDerived: true,
    compute: (r) => sumNullable(r.map((x) => x.assistantQuestions)),
  },
  searches: {
    label: 'Buscas no acervo',
    unit: 'count',
    higherIsBetter: true,
    studentDerived: true,
    compute: (r) => sumNullable(r.map((x) => x.searches)),
  },
  deviceUptimePct: {
    label: 'Disponibilidade dos dispositivos (%)',
    unit: 'percent',
    higherIsBetter: true,
    compute: (r) => mean(r.map((x) => x.deviceUptimePct)),
  },
  devicesTotal: {
    label: 'Dispositivos instalados',
    unit: 'count',
    higherIsBetter: true,
    compute: (r) => latest(r, 'devicesTotal'),
  },
  firmwareCurrentPct: {
    label: 'Dispositivos no firmware mais recente (%)',
    unit: 'percent',
    higherIsBetter: true,
    compute: (r) => latest(r, 'firmwareCurrentPct'),
  },
  incidentsOpened: {
    label: 'Incidentes abertos no período',
    unit: 'count',
    higherIsBetter: false,
    compute: (r) => total(r, 'incidentsOpened'),
  },
  incidentsPer100Classes: {
    label: 'Incidentes por 100 aulas programadas',
    unit: 'count',
    higherIsBetter: false,
    compute: (r) => {
      const v = ratio(total(r, 'incidentsOpened'), total(r, 'classesScheduled'));
      return v === null ? null : round(v * 100, 1);
    },
  },
  mttrMinutes: {
    label: 'Tempo médio de resolução de incidentes (min)',
    unit: 'minutes',
    higherIsBetter: false,
    compute: (r) =>
      weightedMean(r.map((x) => ({ value: x.mttrMinutes, weight: x.incidentsResolved }))),
  },
  totalCostUsd: {
    label: 'Custo total estimado (US$)',
    unit: 'usd',
    higherIsBetter: false,
    compute: totalCost,
  },
  aiCostUsd: {
    label: 'Custo de IA (US$)',
    unit: 'usd',
    higherIsBetter: false,
    compute: (r) => round(total(r, 'aiCostUsd'), 4),
  },
  costPerCapturedClass: {
    label: 'Custo por aula capturada (US$)',
    unit: 'usd',
    higherIsBetter: false,
    compute: (r) => {
      const captured = total(r, 'classesCaptured');
      return captured > 0 ? round(totalCost(r) / captured, 4) : null;
    },
  },
  aiCostPerCapturedClass: {
    label: 'Custo de IA por aula capturada (US$)',
    unit: 'usd',
    higherIsBetter: false,
    compute: (r) => {
      const captured = total(r, 'classesCaptured');
      return captured > 0 ? round(total(r, 'aiCostUsd') / captured, 4) : null;
    },
  },
} satisfies Record<string, MetricDef>;

export type MetricName = keyof typeof METRICS;
export const METRIC_NAMES = Object.keys(METRICS) as MetricName[];

export const isMetric = (m: string): m is MetricName => m in METRICS;

export function computeMetric(name: MetricName, rows: readonly InstitutionDaily[]): number | null {
  const def: MetricDef = METRICS[name];
  return def.compute(rows);
}

export function metricCatalogue(): {
  name: MetricName;
  label: string;
  unit: string;
  higherIsBetter: boolean;
  studentDerived: boolean;
}[] {
  return METRIC_NAMES.map((name) => {
    const def: MetricDef = METRICS[name];
    return {
      name,
      label: def.label,
      unit: def.unit,
      higherIsBetter: def.higherIsBetter,
      studentDerived: def.studentDerived ?? false,
    };
  });
}

export function costByCategory(rows: readonly CostDaily[]): Record<string, number> {
  const out: Record<string, number> = { ai: 0, stt: 0, storage: 0, compute: 0, hardware: 0 };
  for (const r of rows) out[r.category] = round((out[r.category] ?? 0) + r.amountUsd, 6);
  for (const k of Object.keys(out)) out[k] = round(out[k] ?? 0, 4);
  return out;
}
