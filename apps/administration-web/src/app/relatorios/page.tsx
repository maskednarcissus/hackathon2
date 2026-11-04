import type { Metadata } from 'next';
import { ReportTable, SummaryTiles } from '../../components/ReportTable';
import { Breadcrumb, Empty, ServiceError } from '../../components/ui';
import { REPORT_KINDS, REPORT_LABELS, getReport, isReportKind } from '../../lib/analytics';
import { addDays, isIsoDate, query, today } from '../../lib/http';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Relatórios operacionais — Classroom Intelligence' };

const DESCRIPTIONS: Record<(typeof REPORT_KINDS)[number], string> = {
  'capture-coverage': 'Aulas agendadas x capturadas por campus, sala e dia.',
  'transcription-success': 'Taxa de sucesso, confiança média e falhas por motivo.',
  corrections: 'Correções de transcrição e edições/rejeições de eventos por disciplina.',
  'processing-latency': 'Tempo do fim da aula até transcrição, resumo e eventos (p50/p95).',
};

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; from?: string; to?: string }>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const kind = sp.kind && isReportKind(sp.kind) ? sp.kind : 'capture-coverage';
  const to = isIsoDate(sp.to) ? sp.to : today();
  const from = isIsoDate(sp.from) && sp.from <= to ? sp.from : addDays(to, -30);
  const report = await getReport(kind, { from, to });
  const csvHref = `/relatorios/${kind}/csv${query({ from, to })}`;

  return (
    <main>
      <Breadcrumb trail={[{ href: '/', label: 'Administração' }, { label: 'Relatórios' }]} />
      <h1>Relatórios operacionais</h1>
      <form className="filterForm" method="get" aria-label="Parâmetros do relatório">
        <label>
          Relatório
          <select name="kind" defaultValue={kind}>
            {REPORT_KINDS.map((k) => (
              <option key={k} value={k}>
                {REPORT_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          De
          <input type="date" name="from" defaultValue={from} />
        </label>
        <label>
          Até
          <input type="date" name="to" defaultValue={to} />
        </label>
        <button type="submit" className="button secondary">
          Gerar
        </button>
        <a className="button" href={csvHref} download>
          Baixar CSV
        </a>
      </form>

      <section aria-labelledby="report-h" className="card">
        <h2 id="report-h">{REPORT_LABELS[kind]}</h2>
        <p className="muted">{DESCRIPTIONS[kind]}</p>
        {!report.ok ? (
          <ServiceError
            title="Relatório indisponível"
            message={report.error}
            status={report.status}
          />
        ) : (
          <>
            <SummaryTiles summary={report.data.summary} />
            {report.data.rows.length === 0 ? (
              <Empty>Sem dados no período.</Empty>
            ) : (
              <ReportTable
                report={report.data}
                caption={`${REPORT_LABELS[kind]} — ${from.split('-').reverse().join('/')} a ${to.split('-').reverse().join('/')}`}
                maxRows={500}
              />
            )}
          </>
        )}
      </section>
    </main>
  );
}
