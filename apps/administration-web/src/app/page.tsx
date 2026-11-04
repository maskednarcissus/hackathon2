import type { Metadata } from 'next';
import Link from 'next/link';
import { AutoRefresh } from '../components/AutoRefresh';
import { SummaryTiles } from '../components/ReportTable';
import styles from '../components/dashboard.module.css';
import { Empty, ServiceError, SeverityPill, Tiles } from '../components/ui';
import { getReport } from '../lib/analytics';
import { DEVICE_STATUSES, getFleetHealth } from '../lib/fleet';
import { statusMeta } from '../lib/format';
import { itemsOf, today } from '../lib/http';
import { SEVERITIES, getIncidentStats, listIncidents } from '../lib/incidents';
import {
  formatMinutes,
  incidentTypeLabel,
  severityLabel,
  SEVERITY_ICON,
  SEVERITY_TONE,
} from '../lib/labels';
import { formatRelative } from '../lib/format';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Visão geral do campus — Classroom Intelligence' };

export default async function CampusOverview(): Promise<React.JSX.Element> {
  const day = today();
  const range = { from: day, to: day };
  const [coverage, transcription, latency, fleet, stats, open] = await Promise.all([
    getReport('capture-coverage', range),
    getReport('transcription-success', range),
    getReport('processing-latency', range),
    getFleetHealth(),
    getIncidentStats(range),
    listIncidents({ status: 'open', sort: 'severity' }),
  ]);
  const openIncidents = open.ok ? itemsOf(open.data).slice(0, 5) : [];
  const now = new Date(coverage.fetchedAt);

  return (
    <main>
      <h1>Visão geral do campus</h1>
      <p className="muted">Hoje, {day.split('-').reverse().join('/')} (horário de Brasília).</p>
      <AutoRefresh seconds={60} fetchedAt={coverage.fetchedAt} />

      <div className="grid2">
        <section aria-labelledby="cov-h" className="card">
          <h2 id="cov-h">Cobertura de captura hoje</h2>
          {coverage.ok ? (
            coverage.data.summary ? (
              <SummaryTiles summary={coverage.data.summary} />
            ) : (
              <Empty>Nenhuma aula agendada hoje.</Empty>
            )
          ) : (
            <ServiceError
              title="Cobertura indisponível"
              message={coverage.error}
              status={coverage.status}
            />
          )}
          <Link href="/relatorios?kind=capture-coverage">Relatório completo de cobertura</Link>
        </section>

        <section aria-labelledby="proc-h" className="card">
          <h2 id="proc-h">Processamento</h2>
          {transcription.ok ? (
            <SummaryTiles summary={transcription.data.summary} />
          ) : (
            <ServiceError
              title="Transcrição indisponível"
              message={transcription.error}
              status={transcription.status}
            />
          )}
          {latency.ok ? (
            <SummaryTiles summary={latency.data.summary} />
          ) : (
            <ServiceError
              title="Latência indisponível"
              message={latency.error}
              status={latency.status}
            />
          )}
        </section>
      </div>

      <section aria-labelledby="fleet-h" className="card">
        <h2 id="fleet-h">Dispositivos</h2>
        {fleet.ok ? (
          <Tiles
            items={[
              { label: 'Total', value: fleet.data.summary.total },
              ...DEVICE_STATUSES.filter((s) =>
                ['online', 'recording', 'offline', 'attention_required'].includes(s),
              ).map((s) => {
                const m = statusMeta(s);
                return {
                  label: m.label,
                  icon: m.icon,
                  tone: m.tone,
                  value: fleet.data.summary.byStatus[s] ?? 0,
                };
              }),
            ]}
          />
        ) : (
          <ServiceError title="Frota indisponível" message={fleet.error} status={fleet.status} />
        )}
        <Link href="/devices">Console da frota</Link>
      </section>

      <section aria-labelledby="inc-h" className="card">
        <h2 id="inc-h">Incidentes abertos</h2>
        {stats.ok ? (
          <Tiles
            items={[
              ...SEVERITIES.map((s) => ({
                label: severityLabel(s),
                icon: SEVERITY_ICON[s] ?? '',
                tone: SEVERITY_TONE[s] ?? 'muted',
                value: stats.data.openBySeverity[s] ?? 0,
              })),
              {
                label: 'SLA estourado',
                icon: '⏱',
                tone: stats.data.slaBreaches > 0 ? 'danger' : 'muted',
                value: stats.data.slaBreaches,
              },
              { label: 'Tempo médio até reconhecer', value: formatMinutes(stats.data.mttaMinutes) },
              { label: 'Tempo médio até resolver', value: formatMinutes(stats.data.mttrMinutes) },
            ]}
          />
        ) : (
          <ServiceError
            title="Estatísticas de incidentes indisponíveis"
            message={stats.error}
            status={stats.status}
          />
        )}
        {!open.ok ? null : openIncidents.length === 0 ? (
          <Empty>Nenhum incidente aberto. 🎉</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>Mais urgentes</caption>
              <thead>
                <tr>
                  <th scope="col">Severidade</th>
                  <th scope="col">Tipo</th>
                  <th scope="col">Local</th>
                  <th scope="col">Aberto</th>
                </tr>
              </thead>
              <tbody>
                {openIncidents.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <SeverityPill severity={i.severity} />
                    </td>
                    <td>
                      <Link href={`/incidentes/${encodeURIComponent(i.id)}`}>
                        {incidentTypeLabel(i.type)}
                      </Link>
                    </td>
                    <td>{i.classroomName ?? i.campusName ?? '—'}</td>
                    <td>{formatRelative(i.openedAt, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Link href="/incidentes">Fila de incidentes</Link>
      </section>
    </main>
  );
}
