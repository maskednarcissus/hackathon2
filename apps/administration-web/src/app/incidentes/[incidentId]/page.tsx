import type { Metadata } from 'next';
import Link from 'next/link';
import { ActionForm } from '../../../components/ActionForm';
import { SlaBadge } from '../../../components/SlaBadge';
import styles from '../../../components/dashboard.module.css';
import { Breadcrumb, Empty, ServiceError, SeverityPill } from '../../../components/ui';
import { formatDateTime } from '../../../lib/format';
import { actorId } from '../../../lib/http';
import { RESOLUTION_CODES, getIncident } from '../../../lib/incidents';
import { incidentStatusLabel, incidentTypeLabel, resolutionLabel } from '../../../lib/labels';
import { assignAction, commentAction, resolveAction, statusAction } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Incidente — Classroom Intelligence' };

export default async function IncidentPage({
  params,
}: {
  params: Promise<{ incidentId: string }>;
}): Promise<React.JSX.Element> {
  const { incidentId } = await params;
  const result = await getIncident(incidentId);
  const trail = [
    { href: '/', label: 'Administração' },
    { href: '/incidentes', label: 'Incidentes' },
    { label: incidentId.slice(0, 8) },
  ];
  if (!result.ok) {
    return (
      <main>
        <Breadcrumb trail={trail} />
        <h1>Incidente</h1>
        <ServiceError
          title={
            result.status === 404
              ? 'Incidente não encontrado'
              : 'Não foi possível carregar o incidente'
          }
          message={result.error}
          status={result.status}
        />
      </main>
    );
  }
  const i = result.data;
  const resolved = i.status === 'resolved';
  const comments = i.comments ?? [];
  const timeline = i.timeline ?? [];

  return (
    <main>
      <Breadcrumb trail={trail} />
      <h1>
        {i.title ?? incidentTypeLabel(i.type)} <SeverityPill severity={i.severity} />
      </h1>
      {i.message ? <p>{i.message}</p> : null}

      <dl className={styles.metricGrid}>
        <div>
          <dt>Status</dt>
          <dd>{incidentStatusLabel(i.status)}</dd>
        </div>
        <div>
          <dt>SLA</dt>
          <dd>
            <SlaBadge dueAt={i.slaDueAt} breached={i.slaBreached} resolved={resolved} />
          </dd>
        </div>
        <div>
          <dt>Aberto em</dt>
          <dd>{formatDateTime(i.openedAt)}</dd>
        </div>
        <div>
          <dt>Responsável</dt>
          <dd>{i.assigneeId ?? 'Ninguém'}</dd>
        </div>
        <div>
          <dt>Local</dt>
          <dd>
            {[i.campusName, i.classroomName ?? i.classroomId].filter(Boolean).join(' · ') || '—'}
          </dd>
        </div>
        <div>
          <dt>Dispositivo</dt>
          <dd>
            {i.deviceId ? (
              <Link href={`/devices/${encodeURIComponent(i.deviceId)}`}>
                {i.deviceId.slice(0, 8)}
              </Link>
            ) : (
              '—'
            )}
          </dd>
        </div>
        {resolved ? (
          <div>
            <dt>Resolução</dt>
            <dd>
              {resolutionLabel(i.resolutionCode)} em {formatDateTime(i.resolvedAt)}
              {i.resolutionNote ? <div className="muted">{i.resolutionNote}</div> : null}
            </dd>
          </div>
        ) : null}
      </dl>

      {!resolved ? (
        <section aria-labelledby="actions-h" className="card">
          <h2 id="actions-h">Tratamento</h2>
          <ActionForm
            action={assignAction.bind(null, i.id)}
            submitLabel="Atribuir"
            tone="secondary"
          >
            <label>
              Responsável (ID)
              <input name="assigneeId" defaultValue={i.assigneeId ?? actorId()} size={38} />
            </label>
          </ActionForm>
          <div className="actionForm">
            {i.status === 'open' ? (
              <ActionForm
                action={statusAction.bind(null, i.id)}
                submitLabel="Reconhecer"
                tone="secondary"
              >
                <input type="hidden" name="status" value="acknowledged" />
              </ActionForm>
            ) : null}
            {i.status !== 'in_progress' ? (
              <ActionForm
                action={statusAction.bind(null, i.id)}
                submitLabel="Marcar em andamento"
                tone="secondary"
              >
                <input type="hidden" name="status" value="in_progress" />
              </ActionForm>
            ) : null}
          </div>
          <h3>Resolver</h3>
          <ActionForm action={resolveAction.bind(null, i.id)} submitLabel="Resolver incidente">
            <label>
              Código de resolução
              <select name="resolutionCode" defaultValue="" required>
                <option value="" disabled>
                  Selecione…
                </option>
                {RESOLUTION_CODES.map((c) => (
                  <option key={c} value={c}>
                    {resolutionLabel(c)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Observação
              <textarea name="note" maxLength={2000} />
            </label>
          </ActionForm>
        </section>
      ) : null}

      <section aria-labelledby="comments-h" className="card">
        <h2 id="comments-h">Comentários</h2>
        {comments.length === 0 ? (
          <Empty>Nenhum comentário.</Empty>
        ) : (
          <ol>
            {comments.map((c, idx) => (
              <li key={c.id ?? idx}>
                <strong>{c.actorId.slice(0, 8)}</strong>{' '}
                <span className="muted">{formatDateTime(c.createdAt)}</span>
                <p style={{ margin: '0.25rem 0 0.75rem' }}>{c.body}</p>
              </li>
            ))}
          </ol>
        )}
        <ActionForm action={commentAction.bind(null, i.id)} submitLabel="Comentar" tone="secondary">
          <label>
            Novo comentário
            <textarea name="body" required maxLength={4000} />
          </label>
        </ActionForm>
      </section>

      {timeline.length > 0 ? (
        <section aria-labelledby="timeline-h" className="card">
          <h2 id="timeline-h">Linha do tempo</h2>
          <ol>
            {timeline.map((t, idx) => (
              <li key={`${t.at}-${idx}`}>
                {formatDateTime(t.at)} — {t.action}
                {t.actorId ? ` (${t.actorId.slice(0, 8)})` : ''}
                {t.detail ? `: ${t.detail}` : ''}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </main>
  );
}
