import type { Metadata } from 'next';
import styles from '../../../../components/dashboard.module.css';
import { Breadcrumb, Empty, Pill, RatioBar, ServiceError, Tiles } from '../../../../components/ui';
import { getCoverage } from '../../../../lib/analytics';
import {
  COVERAGE_ICON,
  coverageStatusLabel,
  formatDate,
  formatPercent,
} from '../../../../lib/labels';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Plano de ensino x aulas — Classroom Intelligence' };

const TONE = { covered: 'success', partial: 'warning', not_covered: 'danger' } as const;

export default async function CourseCoveragePage({
  params,
}: {
  params: Promise<{ courseId: string }>;
}): Promise<React.JSX.Element> {
  const { courseId } = await params;
  const result = await getCoverage(courseId);
  const trail = [
    { href: '/', label: 'Administração' },
    { href: '/coordenacao', label: 'Coordenação' },
    { label: result.ok ? (result.data.courseName ?? courseId) : courseId },
  ];

  if (!result.ok) {
    return (
      <main>
        <Breadcrumb trail={trail} />
        <h1>Plano de ensino x tópicos das aulas</h1>
        <ServiceError
          title={
            result.status === 404
              ? 'Plano de ensino não cadastrado para esta disciplina'
              : 'Cobertura indisponível'
          }
          message={result.error}
          status={result.status}
        />
      </main>
    );
  }

  const { items, coverageRatio } = result.data;
  const count = (s: string): number => items.filter((i) => i.status === s).length;

  return (
    <main>
      <Breadcrumb trail={trail} />
      <h1>Plano de ensino x tópicos das aulas — {result.data.courseName ?? courseId}</h1>
      <p className="muted">
        A correspondência entre itens do plano e tópicos detectados nas aulas é calculada
        automaticamente (similaridade de termos e semântica). Coberto ≥ 75%, parcial ≥ 50%.
      </p>
      <Tiles
        items={[
          { label: 'Cobertura geral', value: formatPercent(coverageRatio) },
          {
            label: coverageStatusLabel('covered'),
            icon: COVERAGE_ICON.covered,
            tone: 'success',
            value: count('covered'),
          },
          {
            label: coverageStatusLabel('partial'),
            icon: COVERAGE_ICON.partial,
            tone: 'warning',
            value: count('partial'),
          },
          {
            label: coverageStatusLabel('not_covered'),
            icon: COVERAGE_ICON.not_covered,
            tone: 'danger',
            value: count('not_covered'),
          },
          {
            label: 'Atrasados',
            icon: '⏱',
            tone: 'warning',
            value: items.filter((i) => i.behindSchedule).length,
          },
        ]}
      />
      {items.length === 0 ? (
        <Empty>O plano de ensino não tem itens.</Empty>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>Itens do plano de ensino</caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Status</th>
                <th scope="col">Pontuação</th>
                <th scope="col">Semana prevista</th>
                <th scope="col">Primeira aula</th>
                <th scope="col">Aulas correspondentes</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td className="wrap">{i.title}</td>
                  <td>
                    <Pill icon={COVERAGE_ICON[i.status] ?? '?'} tone={TONE[i.status]}>
                      {coverageStatusLabel(i.status)}
                    </Pill>
                    {i.behindSchedule ? (
                      <div>
                        <Pill icon="⏱" tone="warning">
                          Atrasado
                        </Pill>
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <RatioBar value={i.coverageScore} label={`Pontuação de ${i.title}`} />
                  </td>
                  <td>{i.plannedWeek ?? '—'}</td>
                  <td>{i.firstCoveredWeek != null ? `semana ${i.firstCoveredWeek}` : '—'}</td>
                  <td className="wrap">
                    {i.matchedLectures.length === 0 ? (
                      '—'
                    ) : (
                      <ul style={{ margin: 0, paddingLeft: '1rem' }}>
                        {i.matchedLectures.slice(0, 5).map((m) => (
                          <li key={`${m.scheduledClassId}-${m.topicTitle}`}>
                            {formatDate(m.date)} — {m.topicTitle} ({formatPercent(m.score)})
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
