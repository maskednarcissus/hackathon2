import type { Metadata } from 'next';
import Link from 'next/link';
import { ConflictTable } from '../../components/ConflictTable';
import styles from '../../components/dashboard.module.css';
import { Breadcrumb, CohortValue, Empty, RatioBar, ServiceError } from '../../components/ui';
import {
  conflictsOf,
  getAdoption,
  getAssessmentCalendar,
  getAssessmentConflicts,
  getCoverage,
  type ProfessorAdoption,
} from '../../lib/analytics';
import { addDays, isIsoDate, today } from '../../lib/http';
import { formatPercent, formatWeekday } from '../../lib/labels';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Coordenação — Classroom Intelligence' };

interface CourseRow {
  courseId: string;
  courseName: string;
  sections: number;
  scheduled: number;
  captured: number;
}

function coursesOf(professors: ProfessorAdoption[]): CourseRow[] {
  const map = new Map<string, CourseRow>();
  for (const p of professors) {
    const row = map.get(p.courseId) ?? {
      courseId: p.courseId,
      courseName: p.courseName ?? p.courseId,
      sections: 0,
      scheduled: 0,
      captured: 0,
    };
    row.sections += 1;
    row.scheduled += p.classesScheduled;
    row.captured += p.classesCaptured;
    map.set(p.courseId, row);
  }
  return [...map.values()].sort((a, b) => a.courseName.localeCompare(b.courseName, 'pt-BR'));
}

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

export default async function CoordinatorWorkspace({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const to = isIsoDate(sp.to) ? sp.to : today();
  const from = isIsoDate(sp.from) ? sp.from : addDays(to, -30);
  const ahead = { from: today(), to: addDays(today(), 21) };

  const [adoption, calendar, conflicts] = await Promise.all([
    getAdoption({ from, to }),
    getAssessmentCalendar(ahead),
    getAssessmentConflicts(ahead),
  ]);
  const courses = adoption.ok ? coursesOf(adoption.data.professors) : [];
  const coverage = await Promise.all(courses.slice(0, 30).map((c) => getCoverage(c.courseId)));
  const coverageBy = new Map(courses.map((c, i) => [c.courseId, coverage[i]]));

  return (
    <main>
      <Breadcrumb trail={[{ href: '/', label: 'Administração' }, { label: 'Coordenação' }]} />
      <h1>Área da coordenação</h1>

      <form className="filterForm" method="get" aria-label="Período da análise de adoção">
        <label>
          De
          <input type="date" name="from" defaultValue={from} />
        </label>
        <label>
          Até
          <input type="date" name="to" defaultValue={to} />
        </label>
        <button type="submit" className="button secondary">
          Aplicar
        </button>
      </form>

      <section aria-labelledby="courses-h" className="card">
        <h2 id="courses-h">Disciplinas</h2>
        {!adoption.ok ? (
          <ServiceError
            title="Dados de adoção indisponíveis"
            message={adoption.error}
            status={adoption.status}
          />
        ) : courses.length === 0 ? (
          <Empty>Nenhuma turma com aulas no período.</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>Cobertura do plano de ensino e captura por disciplina</caption>
              <thead>
                <tr>
                  <th scope="col">Disciplina</th>
                  <th scope="col">Turmas</th>
                  <th scope="col">Aulas capturadas</th>
                  <th scope="col">Cobertura do plano</th>
                </tr>
              </thead>
              <tbody>
                {courses.map((c) => {
                  const cov = coverageBy.get(c.courseId);
                  return (
                    <tr key={c.courseId}>
                      <td>
                        <Link href={`/coordenacao/cursos/${encodeURIComponent(c.courseId)}`}>
                          {c.courseName}
                        </Link>
                      </td>
                      <td>{c.sections}</td>
                      <td>
                        {c.captured}/{c.scheduled} ({formatPercent(ratio(c.captured, c.scheduled))})
                      </td>
                      <td>
                        {cov?.ok ? (
                          <RatioBar
                            value={cov.data.coverageRatio}
                            label={`Cobertura de ${c.courseName}`}
                          />
                        ) : (
                          <span className="muted">
                            {cov?.status === 404 ? 'sem plano cadastrado' : 'indisponível'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {adoption.ok && adoption.data.professors.length > 0 ? (
        <section aria-labelledby="adoption-h" className="card">
          <h2 id="adoption-h">Adoção por professor e turma</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>
                Período {from.split('-').reverse().join('/')} a {to.split('-').reverse().join('/')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Professor</th>
                  <th scope="col">Turma</th>
                  <th scope="col">Agendadas</th>
                  <th scope="col">Capturadas</th>
                  <th scope="col">Transcritas</th>
                  <th scope="col">Estruturadas</th>
                  <th scope="col">Eventos extraídos</th>
                  <th scope="col">Taxa de revisão</th>
                  <th scope="col">Mediana até revisar</th>
                  <th scope="col">Correções</th>
                </tr>
              </thead>
              <tbody>
                {adoption.data.professors.map((p) => (
                  <tr key={`${p.professorId}-${p.classSectionId}`}>
                    <td>{p.professorName ?? p.professorId}</td>
                    <td>
                      {p.courseName ?? p.courseId}
                      {p.sectionCode ? ` (${p.sectionCode})` : ''}
                    </td>
                    <td>{p.classesScheduled}</td>
                    <td>{p.classesCaptured}</td>
                    <td>{p.classesTranscribed}</td>
                    <td>{p.classesStructured}</td>
                    <td>{p.eventsExtracted}</td>
                    <td>{formatPercent(p.reviewRate)}</td>
                    <td>
                      {p.medianReviewLatencyHours == null
                        ? '—'
                        : `${p.medianReviewLatencyHours.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h`}
                    </td>
                    <td>{p.correctionsMade}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {adoption.ok && adoption.data.sections.length > 0 ? (
        <section aria-labelledby="eng-h" className="card">
          <h2 id="eng-h">Engajamento dos estudantes por turma</h2>
          <p className="muted">
            Valores agregados. Turmas com menos de 5 estudantes ativos aparecem como “—”.
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>Visualizações, buscas e perguntas ao assistente</caption>
              <thead>
                <tr>
                  <th scope="col">Turma</th>
                  <th scope="col">Visualizações</th>
                  <th scope="col">Buscas</th>
                  <th scope="col">Perguntas ao assistente</th>
                </tr>
              </thead>
              <tbody>
                {adoption.data.sections.map((s) => (
                  <tr key={s.classSectionId}>
                    <td>
                      {s.courseName ?? s.courseId ?? s.classSectionId}
                      {s.sectionCode ? ` (${s.sectionCode})` : ''}
                    </td>
                    <td>
                      <CohortValue value={s.views} suppressed={s.suppressed === true} />
                    </td>
                    <td>
                      <CohortValue value={s.searches} suppressed={s.suppressed === true} />
                    </td>
                    <td>
                      <CohortValue
                        value={s.assistantQuestions}
                        suppressed={s.suppressed === true}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <div className="grid2">
        <section aria-labelledby="cal-h" className="card">
          <h2 id="cal-h">Próximas avaliações (3 semanas)</h2>
          {!calendar.ok ? (
            <ServiceError
              title="Calendário indisponível"
              message={calendar.error}
              status={calendar.status}
            />
          ) : calendar.data.days.filter((d) => d.assessments.length > 0).length === 0 ? (
            <Empty>Nenhuma avaliação agendada.</Empty>
          ) : (
            <ul>
              {calendar.data.days
                .filter((d) => d.assessments.length > 0)
                .slice(0, 10)
                .map((d) => (
                  <li key={d.date}>
                    <strong>{formatWeekday(d.date)}</strong>: {d.assessments.length} avaliação(ões)
                  </li>
                ))}
            </ul>
          )}
          <Link href="/calendario-avaliacoes">Calendário completo</Link>
        </section>
        <section aria-labelledby="conf-h" className="card">
          <h2 id="conf-h">Conflitos entre disciplinas</h2>
          {conflicts.ok ? (
            <ConflictTable
              conflicts={conflictsOf(conflicts.data).slice(0, 5)}
              caption="Principais conflitos"
            />
          ) : (
            <ServiceError
              title="Conflitos indisponíveis"
              message={conflicts.error}
              status={conflicts.status}
            />
          )}
        </section>
      </div>
    </main>
  );
}
