import type { Metadata } from 'next';
import { DsrActions } from '../../../../components/DsrActions';
import styles from '../../../../components/dashboard.module.css';
import { Breadcrumb, Empty, ServiceError } from '../../../../components/ui';
import { formatDateTime } from '../../../../lib/format';
import { getDsr } from '../../../../lib/governance';
import { dsrStatusLabel, dsrTypeLabel } from '../../../../lib/labels';
import { DueBadge } from '../../../../components/DueBadge';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Solicitação de titular — Classroom Intelligence' };

export default async function DsrDetailPage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}): Promise<React.JSX.Element> {
  const { requestId } = await params;
  const result = await getDsr(requestId);
  const trail = [
    { href: '/', label: 'Administração' },
    { href: '/governanca', label: 'Governança' },
    { href: '/governanca/titulares', label: 'Titulares' },
    { label: requestId.slice(0, 8) },
  ];
  if (!result.ok) {
    return (
      <main>
        <Breadcrumb trail={trail} />
        <h1>Solicitação de titular</h1>
        <ServiceError
          title={result.status === 404 ? 'Solicitação não encontrada' : 'Solicitação indisponível'}
          message={result.error}
          status={result.status}
        />
      </main>
    );
  }
  const r = result.data;
  const results = r.results ?? [];
  const timeline = r.timeline ?? [];
  return (
    <main>
      <Breadcrumb trail={trail} />
      <h1>
        {dsrTypeLabel(r.type)} — {dsrStatusLabel(r.status)}
      </h1>
      <dl className={styles.metricGrid}>
        <div>
          <dt>Titular</dt>
          <dd>
            {r.subjectType} <code>{r.subjectId}</code>
          </dd>
        </div>
        <div>
          <dt>Recebida</dt>
          <dd>{formatDateTime(r.createdAt)}</dd>
        </div>
        <div>
          <dt>Prazo</dt>
          <dd>
            <DueBadge dueAt={r.dueAt} done={r.status === 'completed' || r.status === 'rejected'} />
          </dd>
        </div>
        <div>
          <dt>Canal</dt>
          <dd>{r.channel ?? '—'}</dd>
        </div>
      </dl>
      {r.details ? <p>{r.details}</p> : null}
      {r.rejectionReason ? (
        <p>
          <strong>Motivo da rejeição:</strong> {r.rejectionReason}
        </p>
      ) : null}
      <DsrActions request={r} />

      <section aria-labelledby="res-h" className="card">
        <h2 id="res-h">Resultado por serviço</h2>
        {results.length === 0 ? (
          <Empty>Ainda não executada.</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>Execução nos serviços da plataforma</caption>
              <thead>
                <tr>
                  <th scope="col">Serviço</th>
                  <th scope="col">Status</th>
                  <th scope="col">Itens</th>
                  <th scope="col">Exportação</th>
                </tr>
              </thead>
              <tbody>
                {results.map((x) => (
                  <tr key={x.service}>
                    <td>{x.service}</td>
                    <td>{x.status}</td>
                    <td>{x.items}</td>
                    <td>{x.exportUri ? <code>{x.exportUri}</code> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {timeline.length > 0 ? (
        <section aria-labelledby="tl-h" className="card">
          <h2 id="tl-h">Linha do tempo</h2>
          <ol>
            {timeline.map((t, i) => (
              <li key={`${t.at}-${i}`}>
                {formatDateTime(t.at)} — {dsrStatusLabel(t.status)}
                {t.note ? `: ${t.note}` : ''}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </main>
  );
}
