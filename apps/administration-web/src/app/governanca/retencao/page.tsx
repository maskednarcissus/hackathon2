import type { Metadata } from 'next';
import { ActionForm } from '../../../components/ActionForm';
import { GovernanceTabs } from '../../../components/GovernanceTabs';
import styles from '../../../components/dashboard.module.css';
import { Breadcrumb, Empty, Pill, ServiceError } from '../../../components/ui';
import { formatDateTime } from '../../../lib/format';
import { RETENTION_KINDS, listLegalHolds, listRetentionJobs } from '../../../lib/governance';
import { itemsOf } from '../../../lib/http';
import { holdScopeLabel, retentionKindLabel } from '../../../lib/labels';
import { createHoldAction, releaseHoldAction, runRetentionAction } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Retenção de dados — Classroom Intelligence' };

export default async function RetentionPage(): Promise<React.JSX.Element> {
  const [holds, jobs] = await Promise.all([listLegalHolds(), listRetentionJobs()]);
  const holdList = holds.ok ? itemsOf(holds.data).filter((h) => !h.releasedAt) : [];
  const jobList = jobs.ok
    ? [...itemsOf(jobs.data)].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    : [];

  return (
    <main>
      <Breadcrumb
        trail={[
          { href: '/', label: 'Administração' },
          { href: '/governanca', label: 'Governança' },
          { label: 'Retenção' },
        ]}
      />
      <h1>Retenção de dados</h1>
      <GovernanceTabs current="retencao" />

      <section aria-labelledby="run-h" className="card">
        <h2 id="run-h">Executar política de retenção</h2>
        <p className="muted">
          Elimina áudio, transcrições, resumos e eventos vencidos conforme cada política,
          respeitando as retenções legais. Registros de auditoria nunca são eliminados por este
          processo.
        </p>
        <ActionForm action={runRetentionAction} submitLabel="Iniciar">
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
            <input type="checkbox" name="dryRun" defaultChecked /> Simulação (não elimina nada)
          </label>
          <label>
            Confirmação para execução real
            <input name="confirm" placeholder="Digite ELIMINAR" autoComplete="off" />
          </label>
        </ActionForm>
      </section>

      <section aria-labelledby="jobs-h" className="card">
        <h2 id="jobs-h">Execuções</h2>
        {!jobs.ok ? (
          <ServiceError title="Execuções indisponíveis" message={jobs.error} status={jobs.status} />
        ) : jobList.length === 0 ? (
          <Empty>Nenhuma execução registrada.</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>Execuções de retenção (mais recentes primeiro)</caption>
              <thead>
                <tr>
                  <th scope="col">Início</th>
                  <th scope="col">Modo</th>
                  <th scope="col">Status</th>
                  {RETENTION_KINDS.map((k) => (
                    <th key={k} scope="col">
                      {retentionKindLabel(k)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobList.map((j) => (
                  <tr key={j.id}>
                    <td>{formatDateTime(j.startedAt)}</td>
                    <td>
                      {j.dryRun ? (
                        <Pill icon="◌" tone="info">
                          Simulação
                        </Pill>
                      ) : (
                        <Pill icon="✂" tone="warning">
                          Real
                        </Pill>
                      )}
                    </td>
                    <td>{j.status}</td>
                    {RETENTION_KINDS.map((k) => {
                      const c = j.counts[k];
                      return (
                        <td key={k} className="wrap">
                          {c ? (
                            <>
                              {j.dryRun
                                ? `${c.candidates} a eliminar`
                                : `${c.deleted}/${c.candidates} eliminados`}
                              {c.skippedByHold > 0 ? (
                                <div className="muted">{c.skippedByHold} retidos</div>
                              ) : null}
                              {c.failures > 0 ? (
                                <div className="formError">{c.failures} falhas</div>
                              ) : null}
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="holds-h" className="card">
        <h2 id="holds-h">Retenções legais ativas</h2>
        {!holds.ok ? (
          <ServiceError
            title="Retenções legais indisponíveis"
            message={holds.error}
            status={holds.status}
          />
        ) : holdList.length === 0 ? (
          <Empty>Nenhuma retenção legal ativa.</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>Itens protegidos contra eliminação</caption>
              <thead>
                <tr>
                  <th scope="col">Escopo</th>
                  <th scope="col">Item</th>
                  <th scope="col">Motivo</th>
                  <th scope="col">Desde</th>
                  <th scope="col">Ação</th>
                </tr>
              </thead>
              <tbody>
                {holdList.map((h) => (
                  <tr key={h.id}>
                    <td>{holdScopeLabel(h.scope.type)}</td>
                    <td>
                      <code>{h.scope.id}</code>
                    </td>
                    <td className="wrap">{h.reason}</td>
                    <td>{formatDateTime(h.createdAt)}</td>
                    <td>
                      <ActionForm
                        action={releaseHoldAction.bind(null, h.id)}
                        submitLabel="Liberar"
                        tone="danger"
                        confirm="Liberar esta retenção legal? Os itens voltarão a seguir a política de retenção."
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h3>Nova retenção legal</h3>
        <ActionForm action={createHoldAction} submitLabel="Registrar retenção">
          <label>
            Escopo
            <select name="scopeType" defaultValue="class_section">
              <option value="class_section">Turma</option>
              <option value="recording">Gravação</option>
              <option value="subject">Titular</option>
            </select>
          </label>
          <label>
            ID do item
            <input name="scopeId" required size={38} placeholder="UUID" />
          </label>
          <label>
            Motivo
            <input name="reason" required size={40} placeholder="Ex.: processo nº …" />
          </label>
        </ActionForm>
      </section>
    </main>
  );
}
