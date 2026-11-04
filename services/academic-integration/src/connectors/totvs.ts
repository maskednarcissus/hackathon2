/**
 * TOTVS RM (Educacional) connector.
 *
 * Uses the RM REST API: the framework API (`/api/framework/v1`) to validate the coligada and the
 * educational resources for the academic data. Collections follow the TOTVS API guide paging
 * (`page`, `pageSize` → `{ items, hasNext }`). Every path can be overridden in `mappings.paths`
 * because RM installations commonly expose customised endpoints.
 *
 * Mapping: periodo letivo → term, disciplina → course, turma/disciplina → class section,
 * horário (diaSemana 1 = domingo … 7 = sábado, codSala) → weekly slot, matrícula → enrollment.
 * `since` is applied to enrollments only (`dataAlteracao`), the other collections are small.
 */
import { CanonicalBuilder, hhmm, isoDate } from './canonical.js';
import { ConnectorError, arr, num, obj, str, type ConnectorHttp, type Json } from './http.js';
import type { Connector, ConnectorConfig, PullContext, PullResult } from './types.js';

export const TOTVS_PATHS = {
  company: '/api/framework/v1/companies/{companyId}',
  term: '/api/educacional/v1/periodosLetivos/{termId}',
  courses: '/api/educacional/v1/disciplinas',
  professors: '/api/educacional/v1/professores',
  sections: '/api/educacional/v1/turmasDisciplinas',
  schedules: '/api/educacional/v1/horarios',
  enrollments: '/api/educacional/v1/matriculas',
} as const;

const ACTIVE = new Set(['matriculado', 'ativo', 'cursando']);
const WITHDRAWN = new Set(['trancado', 'cancelado', 'transferido', 'desistente', 'evadido']);
const COMPLETED = new Set(['aprovado', 'reprovado', 'concluído', 'concluido']);

export function totvsEnrollmentStatus(situacao: string | undefined): 'active' | 'withdrawn' | 'completed' | null {
  const s = (situacao ?? '').trim().toLowerCase();
  if (ACTIVE.has(s)) return 'active';
  if (WITHDRAWN.has(s)) return 'withdrawn';
  if (COMPLETED.has(s)) return 'completed';
  return null;
}

export class TotvsRmConnector implements Connector {
  readonly type = 'totvs_rm' as const;

  constructor(
    private readonly config: ConnectorConfig,
    private readonly http: ConnectorHttp,
  ) {}

  private path(name: keyof typeof TOTVS_PATHS, params: Record<string, string> = {}): string {
    let p = this.config.mappings.paths[name] ?? TOTVS_PATHS[name];
    for (const [k, v] of Object.entries(params)) p = p.replace(`{${k}}`, encodeURIComponent(v));
    return p;
  }

  private async list(name: keyof typeof TOTVS_PATHS, query: Record<string, string>): Promise<Json[]> {
    const items: Json[] = [];
    const pageSize = this.config.mappings.pageSize;
    for (let page = 1; page <= 10_000; page++) {
      const res = await this.http.get(this.path(name), {
        query: { ...query, page, pageSize },
      });
      this.http.stats.pages++;
      const body = obj(res.body);
      items.push(...arr(body['items']).map(obj));
      if (body['hasNext'] !== true) return items;
    }
    throw new ConnectorError('paging_runaway', `${name}: more than 10000 pages`);
  }

  async pull(ctx: PullContext): Promise<PullResult> {
    const m = this.config.mappings;
    if (!m.termExternalId)
      throw new ConnectorError('invalid_config', 'mappings.termExternalId (codPerLet) is required');
    const b = new CanonicalBuilder();
    const base = { codColigada: m.companyId, codPerLet: m.termExternalId };

    await this.http.get(this.path('company', { companyId: m.companyId }));
    const termBody = obj(
      (await this.http.get(this.path('term', { termId: m.termExternalId }), { query: { codColigada: m.companyId } })).body,
    );
    const startDate = isoDate(str(termBody['dtInicio']));
    const endDate = isoDate(str(termBody['dtFim']));
    if (!startDate || !endDate)
      throw new ConnectorError('invalid_upstream_data', 'período letivo has no dtInicio/dtFim');
    const term = {
      externalId: str(termBody['codPerLet']) ?? m.termExternalId,
      name: str(termBody['descricao']) ?? m.termExternalId,
      startDate,
      endDate,
    };

    for (const [i, d] of (await this.list('courses', base)).entries()) {
      const code = str(d['codDisc']);
      if (!code) {
        b.warn(`disciplinas[${i}]`, 'connector.missing_id', 'disciplina without codDisc; skipped');
        continue;
      }
      const credits = num(d['creditos']);
      b.addCourse({
        externalId: code,
        code,
        name: str(d['nome']) ?? code,
        discipline: str(d['area']) ?? m.defaultDiscipline,
        ...(credits !== undefined ? { credits: Math.trunc(credits) } : {}),
      });
    }

    for (const [i, p] of (await this.list('professors', { codColigada: m.companyId })).entries())
      b.addProfessor(`professores[${i}]`, {
        externalId: str(p['codProf']),
        name: str(p['nome']),
        email: str(p['email'])?.toLowerCase(),
      });

    const slots = new Map<string, { dayOfWeek: number; startTime: string; endTime: string; classroomId: string }[]>();
    for (const [i, h] of (await this.list('schedules', base)).entries()) {
      const section = str(h['idTurmaDisc']);
      const day = num(h['diaSemana']);
      const start = hhmm(str(h['horaInicial']));
      const end = hhmm(str(h['horaFinal']));
      const room = str(h['codSala']);
      const path = `horarios[${i}]`;
      if (!section || day === undefined || day < 1 || day > 7 || !start || !end || end <= start) {
        b.warn(path, 'connector.invalid_slot', 'horário with invalid diaSemana/horaInicial/horaFinal; skipped');
        continue;
      }
      const classroomId = room ? m.rooms[room] : undefined;
      if (!classroomId) {
        b.warn(path, 'connector.unmapped_room', `sala "${room ?? ''}" is not mapped to a classroom; slot skipped`);
        continue;
      }
      const list = slots.get(section) ?? [];
      list.push({ dayOfWeek: day - 1, startTime: start, endTime: end, classroomId });
      slots.set(section, list);
    }

    for (const [i, t] of (await this.list('sections', base)).entries()) {
      const id = str(t['idTurmaDisc']);
      if (!id) {
        b.warn(`turmasDisciplinas[${i}]`, 'connector.missing_id', 'turma without idTurmaDisc; skipped');
        continue;
      }
      b.addSection(`turmasDisciplinas[${i}]`, {
        externalId: id,
        courseExternalId: str(t['codDisc']) ?? '',
        professorExternalId: str(t['codProf']) ?? '',
        sectionCode: str(t['codTurma']) ?? id,
        schedule: slots.get(id) ?? [],
      });
    }

    const enrollmentQuery = ctx.since ? { ...base, dataAlteracao: ctx.since.toISOString() } : base;
    for (const [i, e] of (await this.list('enrollments', enrollmentQuery)).entries()) {
      const path = `matriculas[${i}]`;
      const section = str(e['idTurmaDisc']);
      const status = totvsEnrollmentStatus(str(e['situacao']));
      if (!section || !b.hasSection(section)) continue; // section skipped above or not in this term
      if (!status) {
        b.warn(path, 'connector.unknown_status', `situação "${str(e['situacao']) ?? ''}" not recognised; skipped`);
        continue;
      }
      const ra = b.addStudent(path, {
        externalId: str(e['ra']),
        name: str(e['nome']),
        email: str(e['email'])?.toLowerCase(),
      });
      if (ra) b.addEnrollment(ra, section, status);
    }

    return {
      payload: b.build({ term, timezone: m.timezone }),
      warnings: b.warnings,
      partial: b.partial,
      stats: { ...this.http.stats, incremental: ctx.since !== undefined },
    };
  }
}
