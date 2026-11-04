'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { StatusPill } from '../../components/StatusPill';
import styles from '../../components/dashboard.module.css';
import type { FleetDevice } from '../../lib/fleet';
import {
  diskUsage,
  formatBytes,
  formatRelative,
  formatTemperature,
  issueLabel,
  statusMeta,
} from '../../lib/format';

type SortKey = 'status' | 'serialNumber' | 'classroom' | 'lastSeenAt' | 'diskFree' | 'queue';
type Direction = 'ascending' | 'descending';

const columns: { key: SortKey; label: string }[] = [
  { key: 'status', label: 'Status' },
  { key: 'serialNumber', label: 'Dispositivo' },
  { key: 'classroom', label: 'Sala' },
  { key: 'lastSeenAt', label: 'Último contato' },
  { key: 'diskFree', label: 'Disco' },
  { key: 'queue', label: 'Fila de envio' },
];

function sortValue(d: FleetDevice, key: SortKey): number | string {
  switch (key) {
    case 'status':
      return statusMeta(d.status).rank;
    case 'serialNumber':
      return d.serialNumber;
    case 'classroom':
      return d.classroomName ?? d.classroomId ?? '￿';
    case 'lastSeenAt':
      return d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0;
    case 'diskFree':
      return d.metrics?.diskFreeBytes ?? Number.POSITIVE_INFINITY;
    case 'queue':
      return d.metrics?.queuedRecordings ?? 0;
  }
}

export function FleetTable({
  devices,
  fetchedAt,
}: {
  devices: FleetDevice[];
  fetchedAt: string;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: Direction }>({
    key: 'status',
    dir: 'ascending',
  });
  const now = new Date(fetchedAt);

  const statuses = useMemo(() => [...new Set(devices.map((d) => d.status))].sort(), [devices]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = devices.filter(
      (d) =>
        (status === 'all' || d.status === status) &&
        (!onlyIssues || d.issues.length > 0) &&
        (!q ||
          [d.serialNumber, d.classroomName, d.classroomId, d.model, d.firmwareVersion, d.deviceId]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q))),
    );
    const factor = sort.dir === 'ascending' ? 1 : -1;
    return filtered.sort((a, b) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      const cmp =
        typeof va === 'number' && typeof vb === 'number'
          ? va - vb
          : String(va).localeCompare(String(vb), 'pt-BR');
      return cmp * factor || a.serialNumber.localeCompare(b.serialNumber);
    });
  }, [devices, query, status, onlyIssues, sort]);

  const toggleSort = (key: SortKey): void =>
    setSort((s) => ({
      key,
      dir: s.key === key && s.dir === 'ascending' ? 'descending' : 'ascending',
    }));

  return (
    <section aria-labelledby="fleet-heading">
      <h2 id="fleet-heading">Frota</h2>
      <div className={styles.filters} role="search">
        <label>
          Buscar
          <input
            type="search"
            value={query}
            placeholder="Série, sala, modelo…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">Todos</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {statusMeta(s).label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={onlyIssues}
            onChange={(e) => setOnlyIssues(e.target.checked)}
          />
          Somente com problemas
        </label>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption aria-live="polite">
            {rows.length} de {devices.length} dispositivos
          </caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" aria-sort={sort.key === c.key ? sort.dir : 'none'}>
                  <button
                    type="button"
                    className={styles.sortButton}
                    onClick={() => toggleSort(c.key)}
                  >
                    {c.label}
                    <span aria-hidden="true">
                      {sort.key === c.key ? (sort.dir === 'ascending' ? ' ▲' : ' ▼') : ''}
                    </span>
                  </button>
                </th>
              ))}
              <th scope="col">Temperatura</th>
              <th scope="col">Firmware</th>
              <th scope="col">Problemas</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9}>Nenhum dispositivo corresponde aos filtros.</td>
              </tr>
            ) : (
              rows.map((d) => (
                <tr key={d.deviceId}>
                  <td>
                    <StatusPill status={d.status} />
                  </td>
                  <th scope="row">
                    <Link href={`/devices/${encodeURIComponent(d.deviceId)}`}>
                      {d.serialNumber}
                    </Link>
                    <div className="muted">{d.model}</div>
                  </th>
                  <td>
                    {d.classroomName ?? d.classroomId ?? (
                      <span className="muted">Não atribuído</span>
                    )}
                  </td>
                  <td>
                    <time dateTime={d.lastSeenAt ?? undefined} title={d.lastSeenAt ?? undefined}>
                      {formatRelative(d.lastSeenAt, now)}
                    </time>
                  </td>
                  <td>{diskUsage(d.metrics?.diskFreeBytes, d.metrics?.diskTotalBytes)}</td>
                  <td>
                    {d.metrics?.queuedRecordings ?? 0} ({formatBytes(d.metrics?.queuedBytes ?? 0)})
                  </td>
                  <td>{formatTemperature(d.metrics?.cpuTemperatureC)}</td>
                  <td>{d.metrics?.firmwareVersion ?? d.firmwareVersion}</td>
                  <td>
                    {d.issues.length === 0 ? (
                      <span className="muted">Nenhum</span>
                    ) : (
                      <ul className={styles.issues}>
                        {d.issues.map((i) => (
                          <li key={i}>{issueLabel(i)}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
