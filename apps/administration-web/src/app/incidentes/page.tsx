import type { Metadata } from 'next';
import Link from 'next/link';
import { AutoRefresh } from '../../components/AutoRefresh';
import { SlaBadge } from '../../components/SlaBadge';
import styles from '../../components/dashboard.module.css';
import { Breadcrumb, Empty, ServiceError, SeverityPill, Tiles } from '../../components/ui';
import { formatRelative } from '../../lib/format';
import { addDays, itemsOf, today } from '../../lib/http';
import {
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  SEVERITIES,
  getIncidentStats,
  listIncidents,
} from '../../lib/incidents';
import {
  SEVERITY_ICON,
  SEVERITY_TONE,
  formatMinutes,
  incidentStatusLabel,
  incidentTypeLabel,
  severityLabel,
} from '../../lib/labels';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Incidentes de captura — Classroom Intelligence' };

type Search = {
  status?: string;
  severity?: string;
  type?: string;
  campusId?: string;
  assignee?: string;
  sort?: string;
};

export default async function IncidentsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const status = sp.status === 'all' ? undefined : (sp.status ?? 'open');
  const sort = sp.sort === 'age' ? 'age' : 'severity';
  const [list, stats] = await Promise.all([
    listIncidents({
      status,
      severity: sp.severity || undefined,
      type: sp.type || undefined,
      campusId: sp.campusId || undefined,
      assignee: sp.assignee || undefined,
      sort,
    }),
    getIncidentStats({ from: addDays(today(), -30), to: today() }),
  ]);
  const incidents = list.ok ? itemsOf(list.data) : [];
  const now = new Date(list.fetchedAt);

  return (
    <main>
      <Breadcrumb trail={[{ href: '/', label: 'Administração' }, { label: 'Incidentes' }]} />
      <h1>Fila de incidentes de captura</h1>
      <AutoRefresh seconds={30} fetchedAt={list.fetchedAt} />

      {stats.ok ? (
        <Tiles
          items={[
            ...SEVERITIES.map((s) => ({
              label: `Abertos — ${severityLabel(s)}`,
              icon: SEVERITY_ICON[s],
              tone: SEVERITY_TONE[s],
              value: stats.data.openBySeverity[s] ?? 0,
            })),
            {
              label: 'SLA estourado (30 d)',
              icon: '⏱',
              tone: stats.data.slaBreaches > 0 ? 'danger' : 'muted',
              value: stats.data.slaBreaches,
            },
            { label: 'MTTA (30 d)', value: formatMinutes(stats.data.mttaMinutes) },
            { label: 'MTTR (30 d)', value: formatMinutes(stats.data.mttrMinutes) },
          ]}
        />
      ) : null}

      <form className="filterForm" method="get" aria-label="Filtrar incidentes">
        <label>
          Status
          <select name="status" defaultValue={sp.status ?? 'open'}>
            {INCIDENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {incidentStatusLabel(s)}
              </option>
            ))}
            <option value="all">Todos</option>
          </select>
        </label>
        <label>
          Severidade
          <select name="severity" defaultValue={sp.severity ?? ''}>
            <option value="">Todas</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {severityLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tipo
          <select name="type" defaultValue={sp.type ?? ''}>
            <option value="">Todos</option>
            {INCIDENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {incidentTypeLabel(t)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Campus
          <input name="campusId" defaultValue={sp.campusId ?? ''} placeholder="ID do campus" />
        </label>
        <label>
          Responsável
          <input name="assignee" defaultValue={sp.assignee ?? ''} placeholder="ID do responsável" />
        </label>
        <label>
          Ordenar
          <select name="sort" defaultValue={sort}>
            <option value="severity">Severidade</option>
            <option value="age">Mais antigos</option>
          </select>
        </label>
        <button type="submit" className="button secondary">
          Filtrar
        </button>
      </form>

      {!list.ok ? (
        <ServiceError
          title="Não foi possível carregar os incidentes"
          message={list.error}
          status={list.status}
        />
      ) : incidents.length === 0 ? (
        <Empty>Nenhum incidente com estes filtros.</Empty>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption aria-live="polite">{incidents.length} incidente(s)</caption>
            <thead>
              <tr>
                <th scope="col">Severidade</th>
                <th scope="col">Incidente</th>
                <th scope="col">Local</th>
                <th scope="col">Status</th>
                <th scope="col">Responsável</th>
                <th scope="col">Aberto</th>
                <th scope="col">SLA</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((i) => (
                <tr key={i.id}>
                  <td>
                    <SeverityPill severity={i.severity} />
                  </td>
                  <td className="wrap">
                    <Link href={`/incidentes/${encodeURIComponent(i.id)}`}>
                      {i.title ?? incidentTypeLabel(i.type)}
                    </Link>
                    {i.message ? <div className="muted">{i.message}</div> : null}
                  </td>
                  <td>
                    {i.campusName ?? '—'}
                    <div className="muted">{i.classroomName ?? i.classroomId ?? ''}</div>
                  </td>
                  <td>{incidentStatusLabel(i.status)}</td>
                  <td>{i.assigneeId ? i.assigneeId.slice(0, 8) : 'Ninguém'}</td>
                  <td>{formatRelative(i.openedAt, now)}</td>
                  <td>
                    <SlaBadge
                      dueAt={i.slaDueAt}
                      breached={i.slaBreached}
                      resolved={i.status === 'resolved'}
                    />
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
