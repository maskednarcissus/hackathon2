import type { AssessmentConflict } from '../lib/analytics';
import { conflictKindLabel, formatDate } from '../lib/labels';
import styles from './dashboard.module.css';
import { CohortValue, Empty, SeverityPill } from './ui';

const severityRank: Record<string, number> = { blocking: 0, warning: 1, info: 2 };

export function ConflictTable({
  conflicts,
  caption,
}: {
  conflicts: AssessmentConflict[];
  caption: string;
}): React.JSX.Element {
  if (conflicts.length === 0) return <Empty>Nenhum conflito entre disciplinas no período.</Empty>;
  const sorted = [...conflicts].sort(
    (a, b) =>
      (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9) ||
      (a.date ?? '').localeCompare(b.date ?? ''),
  );
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Severidade</th>
            <th scope="col">Data</th>
            <th scope="col">Tipo</th>
            <th scope="col">Turmas afetadas</th>
            <th scope="col">Alunos afetados</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c, i) => (
            <tr key={`${c.kind}-${c.date ?? ''}-${i}`}>
              <td>
                <SeverityPill severity={c.severity} />
              </td>
              <td>{formatDate(c.date)}</td>
              <td className="wrap">
                {conflictKindLabel(c.kind)}
                {c.message ? <div className="muted">{c.message}</div> : null}
              </td>
              <td className="wrap">
                {c.sections
                  .map(
                    (s) =>
                      `${s.courseName ?? s.courseId ?? s.classSectionId}${s.sectionCode ? ` (${s.sectionCode})` : ''}`,
                  )
                  .join(', ')}
              </td>
              <td>
                <CohortValue value={c.affectedStudents} suppressed={c.suppressed === true} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
