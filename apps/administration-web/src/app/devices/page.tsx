import type { Metadata } from 'next';
import Link from 'next/link';
import { AutoRefresh } from '../../components/AutoRefresh';
import { CommandForm } from '../../components/CommandForm';
import { ErrorState } from '../../components/ErrorState';
import { StatusPill } from '../../components/StatusPill';
import styles from '../../components/dashboard.module.css';
import { Breadcrumb, Empty, Pagination, ServiceError } from '../../components/ui';
import { getFirmware, getFleetPage, type FleetFilters } from '../../lib/console';
import { DEVICE_STATUSES, getFleetHealth } from '../../lib/fleet';
import { diskUsage, formatRelative, issueLabel, statusMeta } from '../../lib/format';
import { query } from '../../lib/http';
import { FleetTable } from './FleetTable';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Dispositivos — Classroom Intelligence' };

const SORTS = [
  { value: 'status', label: 'Status (mais urgente primeiro)' },
  { value: 'lastSeenAt', label: 'Último contato' },
  { value: 'serialNumber', label: 'Número de série' },
  { value: 'classroom', label: 'Sala' },
] as const;

type Search = {
  campusId?: string;
  status?: string;
  firmwareVersion?: string;
  q?: string;
  sort?: string;
  page?: string;
};

export default async function DevicesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const filters: FleetFilters = {
    campusId: sp.campusId || undefined,
    status: sp.status || undefined,
    firmwareVersion: sp.firmwareVersion || undefined,
    q: sp.q || undefined,
    sort: SORTS.some((s) => s.value === sp.sort) ? sp.sort : 'status',
    page,
  };
  const [fleet, firmware] = await Promise.all([getFleetPage(filters), getFirmware()]);
  const trail = [{ href: '/', label: 'Administração' }, { label: 'Dispositivos' }];

  // Backwards compatibility: device-management without the Phase 4 console endpoint.
  if (!fleet.ok && fleet.status === 404) {
    const health = await getFleetHealth();
    return (
      <main>
        <Breadcrumb trail={trail} />
        <h1>Saúde dos dispositivos de captura</h1>
        <p className="muted">
          Console paginado indisponível neste ambiente; exibindo o painel de saúde da frota.
        </p>
        <AutoRefresh seconds={30} fetchedAt={health.fetchedAt} />
        {health.ok ? (
          <FleetTable devices={health.data.devices} fetchedAt={health.fetchedAt} />
        ) : (
          <ErrorState title="Não foi possível carregar a frota" message={health.error} />
        )}
      </main>
    );
  }

  const hrefFor = (p: number): string =>
    `/devices${query({ ...filters, sort: filters.sort === 'status' ? undefined : filters.sort, page: p > 1 ? p : undefined })}`;
  const now = new Date(fleet.fetchedAt);
  const versions = firmware.ok
    ? firmware.data.versions.map((v) => v.version)
    : fleet.ok
      ? (fleet.data.facets?.firmwareVersions ?? [])
      : [];
  const campuses = fleet.ok ? (fleet.data.facets?.campuses ?? []) : [];

  return (
    <main>
      <Breadcrumb trail={trail} />
      <h1>Console da frota de captura</h1>
      <AutoRefresh seconds={30} fetchedAt={fleet.fetchedAt} />

      <form className="filterForm" method="get" role="search" aria-label="Filtrar dispositivos">
        <label>
          Buscar
          <input
            type="search"
            name="q"
            defaultValue={sp.q ?? ''}
            placeholder="Série, sala, modelo…"
          />
        </label>
        <label>
          Campus
          {campuses.length > 0 ? (
            <select name="campusId" defaultValue={sp.campusId ?? ''}>
              <option value="">Todos</option>
              {campuses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <input name="campusId" defaultValue={sp.campusId ?? ''} placeholder="ID do campus" />
          )}
        </label>
        <label>
          Status
          <select name="status" defaultValue={sp.status ?? ''}>
            <option value="">Todos</option>
            {DEVICE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusMeta(s).label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Firmware
          <select name="firmwareVersion" defaultValue={sp.firmwareVersion ?? ''}>
            <option value="">Todas as versões</option>
            {versions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Ordenar por
          <select name="sort" defaultValue={filters.sort}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="button secondary">
          Filtrar
        </button>
        <Link href="/devices">Limpar filtros</Link>
      </form>

      {firmware.ok && firmware.data.versions.length > 0 ? (
        <p className="muted">
          Distribuição de firmware:{' '}
          {firmware.data.versions.map((v) => `${v.version} (${v.count})`).join(' · ')}
        </p>
      ) : null}

      {!fleet.ok ? (
        <ServiceError
          title="Não foi possível carregar a frota"
          message={fleet.error}
          status={fleet.status}
        />
      ) : fleet.data.items.length === 0 ? (
        <Empty>Nenhum dispositivo corresponde aos filtros.</Empty>
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption aria-live="polite">
                {fleet.data.total} dispositivo(s) · página {fleet.data.page}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Dispositivo</th>
                  <th scope="col">Campus / sala</th>
                  <th scope="col">Firmware</th>
                  <th scope="col">Último contato</th>
                  <th scope="col">Disco</th>
                  <th scope="col">Problemas</th>
                  <th scope="col">Comando</th>
                </tr>
              </thead>
              <tbody>
                {fleet.data.items.map((d) => (
                  <tr key={d.deviceId}>
                    <td>
                      <StatusPill status={d.status} />
                    </td>
                    <td>
                      <Link href={`/devices/${encodeURIComponent(d.deviceId)}`}>
                        {d.serialNumber}
                      </Link>
                      <div className="muted">{d.model}</div>
                    </td>
                    <td>
                      {d.campusName ?? '—'}
                      <div className="muted">
                        {d.classroomName ?? d.classroomId ?? 'Não atribuído'}
                      </div>
                    </td>
                    <td>{d.firmwareVersion}</td>
                    <td>{formatRelative(d.lastSeenAt, now)}</td>
                    <td>{diskUsage(d.metrics?.diskFreeBytes, d.metrics?.diskTotalBytes)}</td>
                    <td className="wrap">
                      {d.issues.length === 0 ? (
                        '—'
                      ) : (
                        <ul className={styles.issues}>
                          {d.issues.map((i) => (
                            <li key={i}>{issueLabel(i)}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td>
                      {d.status === 'decommissioned' ? (
                        '—'
                      ) : (
                        <CommandForm deviceId={d.deviceId} compact />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={fleet.data.page}
            pageSize={fleet.data.pageSize}
            total={fleet.data.total}
            hrefFor={hrefFor}
          />
        </>
      )}
    </main>
  );
}
