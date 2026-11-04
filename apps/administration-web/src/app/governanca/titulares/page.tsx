import type { Metadata } from 'next';
import Link from 'next/link';
import { DsrActions } from '../../../components/DsrActions';
import { GovernanceTabs } from '../../../components/GovernanceTabs';
import styles from '../../../components/dashboard.module.css';
import { DueBadge } from '../../../components/DueBadge';
import { Breadcrumb, Empty, ServiceError } from '../../../components/ui';
import { DSR_STATUSES, listDsr } from '../../../lib/governance';
import { itemsOf } from '../../../lib/http';
import { dsrStatusLabel, dsrTypeLabel, formatDate } from '../../../lib/labels';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Direitos dos titulares — Classroom Intelligence' };

export default async function DsrQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const status =
    sp.status && (DSR_STATUSES as readonly string[]).includes(sp.status) ? sp.status : undefined;
  const result = await listDsr(status);
  const requests = result.ok
    ? [...itemsOf(result.data)].sort((a, b) => a.dueAt.localeCompare(b.dueAt))
    : [];

  return (
    <main>
      <Breadcrumb
        trail={[
          { href: '/', label: 'Administração' },
          { href: '/governanca', label: 'Governança' },
          { label: 'Titulares' },
        ]}
      />
      <h1>Solicitações de titulares (LGPD)</h1>
      <GovernanceTabs current="titulares" />
      <p className="muted">Prazo de resposta: 15 dias a partir do recebimento (LGPD, art. 19).</p>

      <form className="filterForm" method="get" aria-label="Filtrar solicitações">
        <label>
          Status
          <select name="status" defaultValue={status ?? ''}>
            <option value="">Todos</option>
            {DSR_STATUSES.map((s) => (
              <option key={s} value={s}>
                {dsrStatusLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="button secondary">
          Filtrar
        </button>
      </form>

      {!result.ok ? (
        <ServiceError
          title="Solicitações indisponíveis"
          message={result.error}
          status={result.status}
        />
      ) : requests.length === 0 ? (
        <Empty>Nenhuma solicitação.</Empty>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>{requests.length} solicitação(ões), ordenadas pelo prazo</caption>
            <thead>
              <tr>
                <th scope="col">Tipo</th>
                <th scope="col">Titular</th>
                <th scope="col">Status</th>
                <th scope="col">Recebida</th>
                <th scope="col">Prazo</th>
                <th scope="col">Ações</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/governanca/titulares/${encodeURIComponent(r.id)}`}>
                      {dsrTypeLabel(r.type)}
                    </Link>
                  </td>
                  <td>
                    {r.subjectType === 'student'
                      ? 'Estudante'
                      : r.subjectType === 'professor'
                        ? 'Professor'
                        : r.subjectType}{' '}
                    <code>{r.subjectId.slice(0, 8)}</code>
                  </td>
                  <td>{dsrStatusLabel(r.status)}</td>
                  <td>{formatDate(r.createdAt)}</td>
                  <td>
                    <DueBadge
                      dueAt={r.dueAt}
                      done={r.status === 'completed' || r.status === 'rejected'}
                    />
                  </td>
                  <td>
                    <DsrActions request={r} />
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
