import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ReportButton } from '@/components/ReportButton';
import { Breadcrumb, ErrorState, StatusBadge } from '@/components/States';
import { calendar } from '@/lib/api';
import {
  CHANGE_FIELD_LABELS,
  EVENT_TYPE_LABELS,
  eventSource,
  eventStatus,
  formatDateLong,
  formatDateTime,
  formatTimestamp,
} from '@/lib/format';
import { guard } from '@/lib/http';
import { transcriptAtMs } from '@/lib/links';
import { requireSession } from '@/lib/session';
import type { CalendarChange } from '@/lib/types';

export const metadata: Metadata = { title: 'Evento' };

function describeValue(field: string | undefined, value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  if ((field === 'eventDate' || field === 'event_date') && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return formatDateLong(value);
  }
  return value;
}

export default async function EventPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}): Promise<React.JSX.Element> {
  await requireSession();
  const { eventId } = await params;
  const [result, historyResult] = await Promise.all([
    calendar.event(eventId),
    calendar.history(eventId),
  ]);
  guard(result);
  if (!result.ok && (result.status === 404 || result.status === 403)) notFound();
  if (!result.ok) {
    return (
      <>
        <Breadcrumb items={[{ href: '/calendario', label: 'Calendário' }, { label: 'Evento' }]} />
        <h1>Evento</h1>
        <ErrorState message={result.message} />
      </>
    );
  }
  const event = result.data;
  const status = eventStatus(event);
  const history: CalendarChange[] = historyResult.ok ? historyResult.data : (event.history ?? []);
  const p = eventSource(event);
  const scheduledClassId = p?.scheduledClassId;

  return (
    <>
      <Breadcrumb items={[{ href: '/calendario', label: 'Calendário' }, { label: event.title }]} />
      <div className="page-header">
        <div>
          <p className="meta">
            <span>{EVENT_TYPE_LABELS[event.type] ?? 'Evento'}</span>
            {event.courseName ? <span>{event.courseName}</span> : null}
          </p>
          <h1>{event.title}</h1>
        </div>
        <StatusBadge {...status} />
      </div>

      <div className="layout-aside">
        <div>
          <section className="card" aria-labelledby="when-title">
            <h2 id="when-title">Quando</h2>
            <p style={{ fontSize: '1.15rem', fontWeight: 600 }}>
              {event.eventDate !== null ? formatDateLong(event.eventDate) : 'Data a confirmar'}
              {event.eventTime ? ` às ${event.eventTime}` : ''}
            </p>
            {event.description !== undefined && <p>{event.description}</p>}
            {event.eventDate === null && (
              <p className="small muted">
                A data mencionada em aula era ambígua. O professor ainda precisa confirmar.
              </p>
            )}
          </section>

          <section className="card" aria-labelledby="source-title">
            <h2 id="source-title">Origem da informação</h2>
            {event.isOfficial ? (
              <p>
                <span className="badge badge--success">Calendário oficial</span> Publicado pela
                instituição.
              </p>
            ) : (
              <>
                <p>
                  <span className="badge badge--ai">Extraído por IA da aula</span>{' '}
                  {status.tone === 'success'
                    ? 'e confirmado pelo professor.'
                    : 'aguardando confirmação do professor.'}
                </p>
                {p?.quote !== undefined && (
                  <>
                    <p className="small muted" style={{ marginBottom: 0 }}>
                      Trecho da aula em que foi anunciado:
                    </p>
                    <blockquote className="quote">“{p.quote}”</blockquote>
                  </>
                )}
                <p className="meta">
                  {p?.startMs !== undefined && (
                    <span>Momento na aula: {formatTimestamp(p.startMs)}</span>
                  )}
                  {p?.confirmedAt !== undefined && (
                    <span>Confirmado em {formatDateTime(p.confirmedAt)}</span>
                  )}
                </p>
                {scheduledClassId !== undefined && p?.startMs !== undefined && (
                  <div className="btn-row">
                    <Link
                      className="btn btn--secondary"
                      href={transcriptAtMs(scheduledClassId, p.startMs, p.segmentIndex)}
                    >
                      Ver na transcrição
                    </Link>
                    <Link
                      className="btn btn--ghost"
                      href={`/aulas/${encodeURIComponent(scheduledClassId)}`}
                    >
                      Ver aula
                    </Link>
                  </div>
                )}
              </>
            )}
            <ReportButton
              resourceType="calendar_event"
              resourceId={event.id}
              classSectionId={event.classSectionId}
              context={`evento ${event.title}`}
            />
          </section>
        </div>

        <aside>
          <section className="card" aria-labelledby="history-title">
            <h2 id="history-title">Histórico de alterações</h2>
            {!historyResult.ok && history.length === 0 ? (
              <p className="muted small">Histórico indisponível no momento.</p>
            ) : history.length === 0 ? (
              <p className="muted">Sem alterações desde a publicação.</p>
            ) : (
              <ol className="list-plain">
                {[...history]
                  .sort((a, b) => b.changedAt.localeCompare(a.changedAt))
                  .map((change, i) => (
                    <li key={`${change.changedAt}-${i}`} className="list-item">
                      <span className="meta">{formatDateTime(change.changedAt)}</span>
                      <p style={{ margin: '4px 0 0' }}>
                        <strong>
                          {CHANGE_FIELD_LABELS[change.field ?? ''] ?? change.field ?? 'Alteração'}
                        </strong>
                        :{' '}
                        <del>
                          <span className="visually-hidden">de </span>
                          {describeValue(change.field, change.previousValue)}
                        </del>{' '}
                        <span aria-hidden="true">→</span>{' '}
                        <ins>
                          <span className="visually-hidden">para </span>
                          {describeValue(change.field, change.newValue)}
                        </ins>
                      </p>
                      {change.reason !== undefined && (
                        <p className="small muted" style={{ margin: 0 }}>
                          Motivo: {change.reason}
                        </p>
                      )}
                    </li>
                  ))}
              </ol>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
