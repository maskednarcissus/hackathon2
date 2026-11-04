import type { Metadata } from 'next';
import Link from 'next/link';
import { AutoRefresh } from '../../../components/AutoRefresh';
import { ErrorState } from '../../../components/ErrorState';
import { Sparkline } from '../../../components/Sparkline';
import { StatusPill } from '../../../components/StatusPill';
import styles from '../../../components/dashboard.module.css';
import { CommandForm } from '../../../components/CommandForm';
import { Empty } from '../../../components/ui';
import { getDiagnostics, type Diagnostics } from '../../../lib/console';
import { getDeviceHealth } from '../../../lib/fleet';
import { commandStatusLabel, formatPercent } from '../../../lib/labels';
import { COMMAND_LABELS, isCommandType } from '../../../lib/console';
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
  const [result, diagnostics] = await Promise.all([
    getDeviceHealth(deviceId),
    getDiagnostics(deviceId),
  ]);
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

      <DiagnosticsSection
        deviceId={device.deviceId}
        decommissioned={device.status === 'decommissioned'}
        diagnostics={diagnostics.ok ? diagnostics.data : null}
        error={diagnostics.ok ? null : diagnostics.status === 404 ? null : diagnostics.error}
      />

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

function certificateText(iso: string | null | undefined): string {
  if (!iso) return '—';
  const days = Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);
  return `${formatDateTime(iso)} (${days < 0 ? 'expirado' : `em ${days} d`})`;
}

function DiagnosticsSection({
  deviceId,
  decommissioned,
  diagnostics,
  error,
}: {
  deviceId: string;
  decommissioned: boolean;
  diagnostics: Diagnostics | null;
  error: string | null;
}): React.JSX.Element {
  const commands = diagnostics?.lastCommands ?? [];
  const backlog = diagnostics?.uploadBacklogTrend ?? [];
  return (
    <section aria-labelledby="diag-heading">
      <h2 id="diag-heading">Diagnóstico e comandos remotos</h2>
      {error ? (
        <p role="alert" className="errorBox">
          Diagnóstico indisponível: {error}
        </p>
      ) : null}
      {diagnostics ? (
        <>
          <dl className={styles.metricGrid}>
            <div>
              <dt>Disponibilidade (24 h)</dt>
              <dd>
                {formatPercent(
                  diagnostics.uptimePercent24h == null ? null : diagnostics.uptimePercent24h / 100,
                  1,
                )}
              </dd>
            </div>
            <div>
              <dt>Heartbeats perdidos (24 h)</dt>
              <dd>{diagnostics.missedHeartbeats24h ?? '—'}</dd>
            </div>
            <div>
              <dt>Firmware</dt>
              <dd>{diagnostics.firmwareVersion ?? '—'}</dd>
            </div>
            <div>
              <dt>Certificado expira</dt>
              <dd>{certificateText(diagnostics.certificateExpiresAt)}</dd>
            </div>
          </dl>
          {backlog.length > 1 ? (
            <Sparkline
              values={backlog.map((b) => b.queuedRecordings)}
              label="Fila de envio (24 h)"
              summary={`atual ${backlog.at(-1)?.queuedRecordings ?? 0} gravações`}
            />
          ) : null}
        </>
      ) : null}

      {decommissioned ? (
        <p className="muted">Dispositivo desativado: comandos remotos indisponíveis.</p>
      ) : (
        <CommandForm deviceId={deviceId} />
      )}

      <h3>Histórico de comandos</h3>
      {commands.length === 0 ? (
        <Empty>Nenhum comando enviado recentemente.</Empty>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>Últimos comandos</caption>
            <thead>
              <tr>
                <th scope="col">Comando</th>
                <th scope="col">Status</th>
                <th scope="col">Emitido</th>
                <th scope="col">Concluído</th>
                <th scope="col">Solicitante</th>
                <th scope="col">Resultado</th>
              </tr>
            </thead>
            <tbody>
              {commands.map((c) => (
                <tr key={c.commandId}>
                  <td>{isCommandType(c.type) ? COMMAND_LABELS[c.type] : c.type}</td>
                  <td>{commandStatusLabel(c.status)}</td>
                  <td>{formatDateTime(c.issuedAt)}</td>
                  <td>{formatDateTime(c.finishedAt)}</td>
                  <td>{c.requestedBy ?? '—'}</td>
                  <td className="wrap">
                    {c.output == null ? (
                      '—'
                    ) : (
                      <code>
                        {typeof c.output === 'string' ? c.output : JSON.stringify(c.output)}
                      </code>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
