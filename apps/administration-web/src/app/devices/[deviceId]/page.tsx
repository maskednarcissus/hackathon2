import type { Metadata } from 'next';
import Link from 'next/link';
import { AutoRefresh } from '../../../components/AutoRefresh';
import { ErrorState } from '../../../components/ErrorState';
import { Sparkline } from '../../../components/Sparkline';
import { StatusPill } from '../../../components/StatusPill';
import styles from '../../../components/dashboard.module.css';
import { getDeviceHealth } from '../../../lib/fleet';
import {
  diskUsage,
  formatBytes,
  formatDateTime,
  formatRelative,
  formatTemperature,
  formatUptime,
  issueLabel,
} from '../../../lib/format';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Dispositivo — Classroom Intelligence' };

interface Props {
  params: Promise<{ deviceId: string }>;
}

export default async function DevicePage({ params }: Props): Promise<React.JSX.Element> {
  const { deviceId } = await params;
  const result = await getDeviceHealth(deviceId);
  const breadcrumb = (
    <p className="breadcrumb">
      <Link href="/">Administração</Link> / <Link href="/devices">Dispositivos</Link> / {deviceId}
    </p>
  );

  if (!result.ok) {
    return (
      <main>
        {breadcrumb}
        <h1>Dispositivo</h1>
        <AutoRefresh seconds={30} fetchedAt={result.fetchedAt} />
        <ErrorState
          title={
            result.status === 404
              ? 'Dispositivo não encontrado'
              : 'Não foi possível carregar o dispositivo'
          }
          message={result.error}
        />
      </main>
    );
  }

  const { device, heartbeats } = result.data;
  const m = device.metrics ?? {};
  const samples = [...heartbeats].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const disk = samples.map((h) => h.diskFreeBytes ?? null);
  const temp = samples.map((h) => h.cpuTemperatureC ?? null);
  const lastDisk = disk.filter((v): v is number => v != null).at(-1);
  const lastTemp = temp.filter((v): v is number => v != null).at(-1);
  const now = new Date(result.fetchedAt);

  const metrics: [string, React.ReactNode][] = [
    ['Status', <StatusPill key="s" status={device.status} />],
    [
      'Último contato',
      `${formatRelative(device.lastSeenAt, now)} (${formatDateTime(device.lastSeenAt)})`,
    ],
    ['Sala', device.classroomName ?? device.classroomId ?? 'Não atribuído'],
    ['Modelo', device.model],
    ['Firmware', m.firmwareVersion ?? device.firmwareVersion],
    ['Gravando agora', m.isRecording ? `Sim (aula ${m.currentScheduledClassId ?? '—'})` : 'Não'],
    ['Disco', diskUsage(m.diskFreeBytes, m.diskTotalBytes)],
    ['Temperatura', formatTemperature(m.cpuTemperatureC)],
    ['Fila de envio', `${m.queuedRecordings ?? 0} gravações (${formatBytes(m.queuedBytes ?? 0)})`],
    ['Gravações descartadas', String(m.evictedRecordings ?? 0)],
    ['Tempo ligado', formatUptime(m.uptimeSeconds)],
    ['Desvio de relógio', m.clockSkewMs ? `${Math.round(m.clockSkewMs / 1000)} s` : '0 s'],
  ];

  return (
    <main>
      {breadcrumb}
      <h1>
        {device.serialNumber} <StatusPill status={device.status} />
      </h1>
      <AutoRefresh seconds={30} fetchedAt={result.fetchedAt} />

      {device.issues.length > 0 && (
        <section aria-labelledby="issues-heading" className="errorBox">
          <h2 id="issues-heading" style={{ marginTop: 0 }}>
            Problemas detectados
          </h2>
          <ul>
            {device.issues.map((i) => (
              <li key={i}>{issueLabel(i)}</li>
            ))}
          </ul>
        </section>
      )}
      {m.lastError ? (
        <p>
          <strong>Último erro reportado:</strong> <code>{String(m.lastError)}</code>
        </p>
      ) : null}

      <section aria-labelledby="metrics-heading">
        <h2 id="metrics-heading">Métricas atuais</h2>
        <dl className={styles.metricGrid}>
          {metrics.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="history-heading">
        <h2 id="history-heading">Histórico ({samples.length} heartbeats)</h2>
        <div className={styles.charts}>
          <Sparkline values={disk} label="Disco livre" summary={`atual ${formatBytes(lastDisk)}`} />
          <Sparkline
            values={temp}
            label="Temperatura"
            summary={`atual ${formatTemperature(lastTemp)}`}
          />
        </div>
        {samples.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>Últimos heartbeats</caption>
              <thead>
                <tr>
                  <th scope="col">Recebido</th>
                  <th scope="col">Disco livre</th>
                  <th scope="col">Temperatura</th>
                  <th scope="col">Fila</th>
                  <th scope="col">Gravando</th>
                </tr>
              </thead>
              <tbody>
                {samples
                  .slice(-20)
                  .reverse()
                  .map((h) => (
                    <tr key={h.receivedAt}>
                      <td>{formatDateTime(h.receivedAt)}</td>
                      <td>{formatBytes(h.diskFreeBytes)}</td>
                      <td>{formatTemperature(h.cpuTemperatureC)}</td>
                      <td>{h.queuedRecordings ?? 0}</td>
                      <td>{h.isRecording ? 'Sim' : 'Não'}</td>
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
