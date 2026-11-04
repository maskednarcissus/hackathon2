import type { Metadata } from 'next';
import { ConflictTable } from '../../components/ConflictTable';
import styles from '../../components/dashboard.module.css';
import { Breadcrumb, Empty, Pill, ServiceError } from '../../components/ui';
import { conflictsOf, getAssessmentCalendar, getAssessmentConflicts } from '../../lib/analytics';
import { addDays, isIsoDate, today } from '../../lib/http';
import { assessmentStatusLabel, assessmentTypeLabel, formatWeekday } from '../../lib/labels';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Calendário de avaliações — Classroom Intelligence' };

/** Days with this many assessments or more are highlighted (text + icon, not color only). */
const HEAVY_DAY = 4;

export default async function AssessmentCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; courseId?: string; programId?: string }>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const from = isIsoDate(sp.from) ? sp.from : today();
  const to = isIsoDate(sp.to) && sp.to >= from ? sp.to : addDays(from, 30);
  const filters = {
    from,
    to,
    courseId: sp.courseId || undefined,
    programId: sp.programId || undefined,
  };
  const [calendar, conflicts] = await Promise.all([
    getAssessmentCalendar(filters),
    getAssessmentConflicts({ from, to }),
  ]);
  const days = calendar.ok ? calendar.data.days.filter((d) => d.assessments.length > 0) : [];

  return (
    <main>
      <Breadcrumb
        trail={[{ href: '/', label: 'Administração' }, { label: 'Calendário de avaliações' }]}
      />
      <h1>Calendário institucional de avaliações</h1>
      <form className="filterForm" method="get" aria-label="Filtros do calendário">
        <label>
          De
          <input type="date" name="from" defaultValue={from} />
        </label>
        <label>
          Até
          <input type="date" name="to" defaultValue={to} />
        </label>
        <label>
          Curso (programa)
          <input name="programId" defaultValue={sp.programId ?? ''} placeholder="ID do curso" />
        </label>
        <label>
          Disciplina
          <input name="courseId" defaultValue={sp.courseId ?? ''} placeholder="ID da disciplina" />
        </label>
        <button type="submit" className="button secondary">
          Aplicar
        </button>
      </form>

      <section aria-labelledby="conf-h" className="card">
        <h2 id="conf-h">Conflitos</h2>
        {conflicts.ok ? (
          <ConflictTable
            conflicts={conflictsOf(conflicts.data)}
            caption="Conflitos entre disciplinas no período"
          />
        ) : (
          <ServiceError
            title="Conflitos indisponíveis"
            message={conflicts.error}
            status={conflicts.status}
          />
        )}
      </section>

      <section aria-labelledby="days-h" className="card">
        <h2 id="days-h">Avaliações por dia</h2>
        {!calendar.ok ? (
          <ServiceError
            title="Calendário indisponível"
            message={calendar.error}
            status={calendar.status}
          />
        ) : days.length === 0 ? (
          <Empty>Nenhuma avaliação no período selecionado.</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>
                {days.length} dia(s) com avaliações entre {from.split('-').reverse().join('/')} e{' '}
                {to.split('-').reverse().join('/')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Dia</th>
                  <th scope="col">Carga</th>
                  <th scope="col">Avaliações</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.date}>
                    <th scope="row">{formatWeekday(d.date)}</th>
                    <td>
                      {d.load >= HEAVY_DAY ? (
                        <Pill icon="⚠" tone="warning">
                          {d.load} — dia carregado
                        </Pill>
                      ) : (
                        d.load
                      )}
                    </td>
                    <td className="wrap">
                      <ul style={{ margin: 0, paddingLeft: '1rem' }}>
                        {d.assessments.map((a, i) => (
                          <li key={a.eventId ?? `${a.classSectionId}-${i}`}>
                            <strong>{assessmentTypeLabel(a.type)}</strong>: {a.title} —{' '}
                            {a.courseName ?? a.courseId}
                            {a.sectionCode ? ` (${a.sectionCode})` : ''}
                            {a.eventTime ? ` às ${a.eventTime}` : ''}{' '}
                            {a.status === 'published' ? (
                              <Pill icon="✓" tone="success">
                                {assessmentStatusLabel(a.status)}
                              </Pill>
                            ) : (
                              <Pill icon="…" tone="warning">
                                {assessmentStatusLabel(a.status)}
                              </Pill>
                            )}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
