import type { Metadata } from 'next';
import Link from 'next/link';
import { AutoRefresh } from '../../components/AutoRefresh';
import { ErrorState } from '../../components/ErrorState';
import styles from '../../components/dashboard.module.css';
import { DEVICE_STATUSES, getFleetHealth } from '../../lib/fleet';
import { statusMeta } from '../../lib/format';
import { FleetTable } from './FleetTable';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Dispositivos — Classroom Intelligence' };

export default async function DevicesPage(): Promise<React.JSX.Element> {
  const result = await getFleetHealth();

  return (
    <main>
      <p className="breadcrumb">
        <Link href="/">Administração</Link> / Dispositivos
      </p>
      <h1>Saúde dos dispositivos de captura</h1>
      <AutoRefresh seconds={30} fetchedAt={result.fetchedAt} />
      {!result.ok ? (
        <ErrorState title="Não foi possível carregar a frota" message={result.error} />
      ) : (
        <>
          <section aria-labelledby="summary-heading">
            <h2
              id="summary-heading"
              className="visually-hidden"
              style={{ position: 'absolute', left: '-9999px' }}
            >
              Resumo
            </h2>
            <ul className={styles.tiles}>
              <li className={styles.tile}>
                <span className={styles.tileValue}>{result.data.summary.total}</span>
                <span className={styles.tileLabel}>Total</span>
              </li>
              {DEVICE_STATUSES.filter(
                (s) =>
                  (result.data.summary.byStatus[s] ?? 0) > 0 ||
                  ['online', 'offline', 'attention_required'].includes(s),
              ).map((s) => {
                const meta = statusMeta(s);
                return (
                  <li key={s} className={`${styles.tile} ${styles[`tone_${meta.tone}`]}`}>
                    <span className={styles.tileValue}>{result.data.summary.byStatus[s] ?? 0}</span>
                    <span className={styles.tileLabel}>
                      <span aria-hidden="true">{meta.icon} </span>
                      {meta.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
          <FleetTable devices={result.data.devices} fetchedAt={result.fetchedAt} />
        </>
      )}
    </main>
  );
}
