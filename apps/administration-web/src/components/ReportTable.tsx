import type { Report, ReportCell } from '../lib/analytics';
import { formatMinutes, formatPercent } from '../lib/labels';
import styles from './dashboard.module.css';
import { CohortValue, isSuppressed } from './ui';

/** Human labels for well-known report keys; unknown keys are shown humanised. */
const KEY_LABELS: Record<string, string> = {
  date: 'Data',
  campusName: 'Campus',
  campusId: 'Campus',
  classroomName: 'Sala',
  classroomId: 'Sala',
  courseName: 'Disciplina',
  courseId: 'Disciplina',
  scheduled: 'Aulas agendadas',
  scheduledClasses: 'Aulas agendadas',
  captured: 'Aulas capturadas',
  capturedClasses: 'Aulas capturadas',
  failed: 'Falhas',
  failedRecordings: 'Gravações com falha',
  coverageRatio: 'Cobertura',
  successRate: 'Taxa de sucesso',
  meanConfidence: 'Confiança média',
  failures: 'Falhas',
  reason: 'Motivo',
  transcriptCorrections: 'Correções de transcrição',
  eventEdits: 'Eventos editados',
  eventRejections: 'Eventos rejeitados',
  stage: 'Etapa',
  p50Minutes: 'p50',
  p95Minutes: 'p95',
  pending: 'Pendentes',
  processing: 'Em processamento',
  transcribed: 'Transcritas',
  structured: 'Estruturadas',
};

export const keyLabel = (key: string): string =>
  KEY_LABELS[key] ??
  key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());

export function formatCell(key: string, value: ReportCell): React.ReactNode {
  if (isSuppressed(value)) return <CohortValue value={null} suppressed />;
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (typeof value === 'number') {
    if (/(Ratio|Rate|Confidence|Percent)$/.test(key) && value <= 1) return formatPercent(value, 1);
    if (/Minutes$/.test(key)) return formatMinutes(value);
    return value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  }
  return typeof value === 'string' ? value : '—';
}

export function ReportTable({
  report,
  caption,
  maxRows,
}: {
  report: Report;
  caption: string;
  maxRows?: number;
}): React.JSX.Element {
  const columns =
    report.columns ?? Object.keys(report.rows[0] ?? {}).map((key) => ({ key, label: undefined }));
  const rows = maxRows ? report.rows.slice(0, maxRows) : report.rows;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption>
          {caption}
          {maxRows && report.rows.length > maxRows
            ? ` (primeiras ${maxRows} de ${report.rows.length} linhas)`
            : ''}
        </caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col">
                {c.label ?? keyLabel(c.key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.key}>{formatCell(c.key, row[c.key] ?? null)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SummaryTiles({
  summary,
}: {
  summary: Record<string, ReportCell> | undefined;
}): React.JSX.Element | null {
  if (!summary) return null;
  const entries = Object.entries(summary);
  if (entries.length === 0) return null;
  return (
    <ul className={styles.tiles}>
      {entries.map(([k, v]) => (
        <li key={k} className={styles.tile}>
          <span className={styles.tileValue}>{formatCell(k, v)}</span>
          <span className={styles.tileLabel}>{keyLabel(k)}</span>
        </li>
      ))}
    </ul>
  );
}
