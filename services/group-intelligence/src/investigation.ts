import { z } from 'zod';
import type { GatewayClient } from './clients.js';
import type { InstitutionRef, Provenance } from './domain.js';
import { isMetric, metricCatalogue, type MetricName } from './metrics.js';
import type { GroupQueries, Range } from './queries.js';
import { addDays, daysBetween } from './stats.js';

export const PLAN_PROMPT_ID = 'group-investigation';
export const ANSWER_PROMPT_ID = 'group-investigation-answer';
export const MAX_TOOL_CALLS = 6;
const MAX_RANGE_DAYS = 366;

export const TOOLS = [
  'metric_by_institution',
  'metric_timeseries',
  'cost_breakdown',
  'compare_periods',
] as const;
export type ToolName = (typeof TOOLS)[number];

// ---------------------------------------------------------------- refusal for individual data

/**
 * Questions that ask about identifiable people (lists, names, a specific student) are refused
 * before any model call. Aggregate questions ("quantos alunos ativos…") are allowed.
 */
const INDIVIDUAL_PATTERNS: RegExp[] = [
  /\b(quem|qual|quais)\s+(é|e|são|sao|foi|foram)?\s*(o|a|os|as)?\s*(alunos?|alunas?|estudantes?|discentes?)\b/i,
  /\b(nomes?|lista(r|gem)?|relação|e-?mails?|cpfs?|matr[ií]culas?|telefones?)\s+(d[eoa]s?\s+)?(alunos?|alunas?|estudantes?|discentes?)\b/i,
  /\b(alunos?|alunas?|estudantes?)\s+(chamad[oa]s?|específic[oa]s?|individua(l|is)|identificad[oa]s?)\b/i,
  /\b(aluno|aluna|estudante)\s+[A-ZÀ-Ú][a-zà-ú]+/,
  /\bcpf\b/i,
  /\b(who|which|list|names? of)\b.*\bstudents?\b/i,
];

export function asksForIndividuals(question: string): boolean {
  return INDIVIDUAL_PATTERNS.some((p) => p.test(question));
}

// ---------------------------------------------------------------- model I/O schemas

const RangeParam = z.object({ from: z.string(), to: z.string() });
const ToolCall = z.object({
  tool: z.string(),
  params: z
    .object({
      metric: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      institutionId: z.string().nullable().optional(),
      granularity: z.string().optional(),
      groupBy: z.string().optional(),
      a: RangeParam.optional(),
      b: RangeParam.optional(),
    })
    .default({}),
});
const PlanOutput = z.object({
  refusal: z.enum(['individual_data_not_available', 'out_of_scope']).nullable().default(null),
  toolCalls: z.array(ToolCall).default([]),
});
const AnswerOutput = z.object({
  answer: z.string().default(''),
  findings: z
    .array(
      z.object({
        statement: z.string(),
        metric: z.string().nullable().default(null),
        value: z.number().nullable().default(null),
        institutionIds: z.array(z.string()).default([]),
        period: z.string().nullable().default(null),
      }),
    )
    .default([]),
  limitations: z.array(z.string()).default([]),
});

const rangeSchema = {
  type: 'object',
  properties: { from: { type: 'string' }, to: { type: 'string' } },
  required: ['from', 'to'],
};

export const PLAN_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    refusal: {
      type: ['string', 'null'],
      enum: ['individual_data_not_available', 'out_of_scope', null],
    },
    toolCalls: {
      type: 'array',
      maxItems: MAX_TOOL_CALLS,
      items: {
        type: 'object',
        properties: {
          tool: { type: 'string', enum: [...TOOLS] },
          params: {
            type: 'object',
            properties: {
              metric: { type: 'string' },
              from: { type: 'string' },
              to: { type: 'string' },
              institutionId: { type: ['string', 'null'] },
              granularity: { type: 'string', enum: ['day', 'week', 'month'] },
              groupBy: { type: 'string', enum: ['institution', 'campus', 'category'] },
              a: rangeSchema,
              b: rangeSchema,
            },
          },
        },
        required: ['tool', 'params'],
      },
    },
  },
  required: ['refusal', 'toolCalls'],
};

export const ANSWER_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          statement: { type: 'string' },
          metric: { type: ['string', 'null'] },
          value: { type: ['number', 'null'] },
          institutionIds: { type: 'array', items: { type: 'string' } },
          period: { type: ['string', 'null'] },
        },
        required: ['statement', 'metric', 'value', 'institutionIds', 'period'],
      },
    },
    limitations: { type: 'array', items: { type: 'string' } },
  },
  required: ['answer', 'findings', 'limitations'],
};

// ---------------------------------------------------------------- numeric grounding

/** Numbers written in a text, accepting pt-BR ("1.234,5", "83,3%") and en ("1234.5") notation. */
export function extractNumbers(text: string): { raw: string; candidates: number[] }[] {
  const out: { raw: string; candidates: number[] }[] = [];
  for (const m of text.matchAll(/-?\d+(?:[.,]\d+)*/g)) {
    const raw = m[0];
    const candidates = new Set<number>();
    if (raw.includes(',')) candidates.add(Number(raw.replace(/\./g, '').replace(',', '.')));
    if (/^-?\d{1,3}(\.\d{3})+$/.test(raw)) candidates.add(Number(raw.replace(/\./g, '')));
    if (!raw.includes(',')) candidates.add(Number(raw));
    if (/^-?\d+(,\d{3})+$/.test(raw)) candidates.add(Number(raw.replace(/,/g, '')));
    out.push({ raw, candidates: [...candidates].filter((n) => Number.isFinite(n)) });
  }
  return out;
}

function collectNumbers(value: unknown, into: Set<number>): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    into.add(value);
    if (Math.abs(value) <= 1) into.add(value * 100); // ratios rendered as percentages
  } else if (typeof value === 'string') {
    for (const n of extractNumbers(value)) for (const c of n.candidates) into.add(c);
  } else if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, into);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectNumbers(v, into);
  }
}

const close = (a: number, b: number): boolean =>
  Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.01);

export function isGrounded(candidates: readonly number[], allowed: ReadonlySet<number>): boolean {
  // Small ordinals and counts of things listed ("3 instituições") are tolerated only if present.
  return candidates.some((c) => [...allowed].some((a) => close(c, a)));
}

export function groundAnswer(
  answer: string,
  allowed: ReadonlySet<number>,
): { answer: string; removed: string[] } {
  const sentences = answer.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const kept: string[] = [];
  const removed: string[] = [];
  for (const s of sentences) {
    const ungrounded = extractNumbers(s).filter((n) => !isGrounded(n.candidates, allowed));
    if (ungrounded.length === 0) kept.push(s);
    else removed.push(s);
  }
  return { answer: kept.join(' '), removed };
}

// ---------------------------------------------------------------- execution

export interface QueryRun {
  tool: ToolName;
  params: Record<string, unknown>;
  rows: Record<string, unknown>[];
}

export interface InvestigationResult {
  answer: string;
  findings: z.infer<typeof AnswerOutput>['findings'];
  queriesRun: QueryRun[];
  refusal:
    'individual_data_not_available' | 'out_of_scope' | 'injection_suspected' | 'no_data' | null;
  limitations: string[];
  ai: { planRequestId: string | null; answerRequestId: string | null; model: string | null };
}

export interface InvestigationDeps {
  gateway: GatewayClient;
  queries: GroupQueries;
  now: () => Date;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function clampRange(
  from: string | undefined,
  to: string | undefined,
  today: string,
  fallback: Range,
): Range | string {
  const f = from ?? fallback.from;
  const t = to ?? fallback.to;
  if (!DATE.test(f) || !DATE.test(t)) return 'datas devem estar no formato AAAA-MM-DD';
  if (t < f) return 'período invertido';
  const end = t > today ? today : t;
  if (daysBetween(f, end) + 1 > MAX_RANGE_DAYS) return `período maior que ${MAX_RANGE_DAYS} dias`;
  return { from: f, to: end };
}

export async function investigate(
  deps: InvestigationDeps,
  holdingCompanyId: string,
  question: string,
  institutions: readonly InstitutionRef[],
  billingInstitutionId: string,
  defaultRange: Range,
): Promise<InvestigationResult> {
  const empty = (
    refusal: InvestigationResult['refusal'],
    limitation: string,
  ): InvestigationResult => ({
    answer: '',
    findings: [],
    queriesRun: [],
    refusal,
    limitations: [limitation],
    ai: { planRequestId: null, answerRequestId: null, model: null },
  });
  if (asksForIndividuals(question))
    return empty(
      'individual_data_not_available',
      'A inteligência de grupo trabalha apenas com dados agregados; não há dados de pessoas individuais.',
    );

  const today = deps.now().toISOString().slice(0, 10);
  const catalogue = metricCatalogue()
    .map((m) => `${m.name} (${m.label}; ${m.unit})`)
    .join('\n');
  const instList = institutions.map((i) => `${i.id} — ${i.name}`).join('\n');
  const plan = await deps.gateway.generate({
    promptId: PLAN_PROMPT_ID,
    variables: {
      today,
      defaultFrom: defaultRange.from,
      defaultTo: defaultRange.to,
      institutions: instList,
      metrics: catalogue,
      tools: TOOLS.join(', '),
    },
    untrustedInputs: { question },
    responseSchema: PLAN_RESPONSE_SCHEMA,
    institutionId: billingInstitutionId,
  });
  const ai = {
    planRequestId: plan.requestId,
    answerRequestId: null as string | null,
    model: plan.model,
  };
  if (plan.injectionSuspected)
    return {
      ...empty(
        'injection_suspected',
        'A pergunta contém instruções suspeitas e não foi processada.',
      ),
      ai,
    };
  const parsedPlan = PlanOutput.safeParse(plan.output);
  if (!parsedPlan.success)
    return {
      ...empty('out_of_scope', 'Não foi possível planejar consultas para esta pergunta.'),
      ai,
    };
  if (parsedPlan.data.refusal) {
    const msg =
      parsedPlan.data.refusal === 'individual_data_not_available'
        ? 'A inteligência de grupo trabalha apenas com dados agregados; não há dados de pessoas individuais.'
        : 'A pergunta está fora do escopo dos dados de inteligência de grupo.';
    return { ...empty(parsedPlan.data.refusal, msg), ai };
  }

  const limitations: string[] = [];
  const ids = new Set(institutions.map((i) => i.id));
  const queriesRun: QueryRun[] = [];
  const calls = parsedPlan.data.toolCalls.slice(0, MAX_TOOL_CALLS);
  if (parsedPlan.data.toolCalls.length > MAX_TOOL_CALLS)
    limitations.push(
      `Apenas as primeiras ${MAX_TOOL_CALLS} consultas planejadas foram executadas.`,
    );

  for (const call of calls) {
    const p = call.params;
    const skip = (why: string): void => {
      limitations.push(`Consulta ${call.tool} ignorada: ${why}.`);
    };
    if (!(TOOLS as readonly string[]).includes(call.tool)) {
      skip('ferramenta desconhecida');
      continue;
    }
    const tool = call.tool as ToolName;
    const metric = p.metric;
    if (tool !== 'cost_breakdown' && (!metric || !isMetric(metric))) {
      skip(`métrica desconhecida "${metric ?? ''}"`);
      continue;
    }
    const m = metric as MetricName;
    if (tool === 'compare_periods') {
      const a = clampRange(p.a?.from, p.a?.to, today, defaultRange);
      const b = clampRange(p.b?.from, p.b?.to, today, {
        from: addDays(defaultRange.from, -(daysBetween(defaultRange.from, defaultRange.to) + 1)),
        to: addDays(defaultRange.from, -1),
      });
      if (typeof a === 'string' || typeof b === 'string') {
        skip(typeof a === 'string' ? a : String(b));
        continue;
      }
      queriesRun.push({
        tool,
        params: { metric: m, a, b },
        rows: await deps.queries.comparePeriods(holdingCompanyId, m, a, b),
      });
      continue;
    }
    const range = clampRange(p.from, p.to, today, defaultRange);
    if (typeof range === 'string') {
      skip(range);
      continue;
    }
    if (tool === 'metric_by_institution') {
      queriesRun.push({
        tool,
        params: { metric: m, ...range },
        rows: await deps.queries.metricByInstitution(holdingCompanyId, m, range),
      });
    } else if (tool === 'metric_timeseries') {
      const granularity =
        p.granularity === 'day' || p.granularity === 'month' ? p.granularity : 'week';
      const inst = p.institutionId ?? null;
      if (inst !== null && !ids.has(inst)) {
        skip('instituição fora do grupo');
        continue;
      }
      queriesRun.push({
        tool,
        params: { metric: m, granularity, institutionId: inst, ...range },
        rows: await deps.queries.metricTimeseries(holdingCompanyId, m, granularity, range, inst),
      });
    } else {
      const groupBy =
        p.groupBy === 'campus' || p.groupBy === 'category' ? p.groupBy : 'institution';
      queriesRun.push({
        tool,
        params: { groupBy, ...range },
        rows: await deps.queries.costBreakdown(holdingCompanyId, groupBy, range),
      });
    }
  }

  if (queriesRun.length === 0 || queriesRun.every((q) => q.rows.length === 0))
    return {
      ...empty('no_data', 'Nenhuma consulta retornou dados para responder à pergunta.'),
      queriesRun,
      ai,
      limitations: [...limitations, 'Nenhuma consulta retornou dados para responder à pergunta.'],
    };

  const answer = await deps.gateway.generate({
    promptId: ANSWER_PROMPT_ID,
    variables: { today, institutions: instList },
    untrustedInputs: { question, results: JSON.stringify(queriesRun) },
    responseSchema: ANSWER_RESPONSE_SCHEMA,
    institutionId: billingInstitutionId,
  });
  ai.answerRequestId = answer.requestId;
  const parsed = AnswerOutput.safeParse(answer.output);
  if (!parsed.success)
    return {
      answer: '',
      findings: [],
      queriesRun,
      refusal: null,
      limitations: [...limitations, 'A resposta do modelo não pôde ser validada.'],
      ai,
    };

  // Every number the model states must come from the executed queries (or their parameters).
  const allowed = new Set<number>();
  collectNumbers(
    queriesRun.map((q) => ({ params: q.params, rows: q.rows })),
    allowed,
  );
  for (const inst of institutions) collectNumbers(inst.name, allowed);
  allowed.add(institutions.length);
  const grounded = groundAnswer(parsed.data.answer, allowed);
  for (const s of grounded.removed)
    limitations.push(`Afirmação removida por não ter suporte nos dados consultados: "${s}"`);

  const findings = parsed.data.findings.filter((f) => {
    const valueOk = f.value === null || isGrounded([f.value, f.value * 100], allowed);
    const textOk = extractNumbers(f.statement).every((n) => isGrounded(n.candidates, allowed));
    const instOk = f.institutionIds.every((id) => ids.has(id));
    if (!(valueOk && textOk && instOk))
      limitations.push(`Achado descartado por falta de suporte nos dados: "${f.statement}"`);
    return valueOk && textOk && instOk;
  });

  return {
    answer: grounded.answer,
    findings,
    queriesRun,
    refusal: null,
    limitations: [...limitations, ...parsed.data.limitations],
    ai,
  };
}

export type InvestigationResponse = InvestigationResult & { provenance: Provenance };
