import Link from 'next/link';
import { ConfidenceBreakdown } from '@/components/ConfidenceBreakdown';
import { ConflictList } from '@/components/ConflictList';
import { EventActions } from '@/components/EventActions';
import { EventDate, EventFlags, EventHeading, SourceQuote } from '@/components/EventSummary';
import { AiNotice, ErrorState, Flash } from '@/components/States';
import { ApiError, getEvent } from '@/lib/api';
import { EVENT_TYPE_LABELS, FIELD_LABELS, formatDateTime, transcriptLink } from '@/lib/format';
import type { AcademicEventType, ExtractedEvent } from '@/lib/types';
import { confirmAction, editAction, publishAction, rejectAction } from '../actions';

export const dynamic = 'force-dynamic';

const RESULT_MESSAGES: Record<string, string> = {
  confirmado: 'Anúncio confirmado.',
  editado: 'Alterações salvas e anúncio confirmado.',
  rejeitado: 'Anúncio rejeitado. Ele não será publicado.',
  publicado: 'Anúncio publicado no calendário dos alunos.',
};

const valueLabel = (field: string, value: string | null): string => {
  if (value === null || value === '') return '—';
  if (field === 'type' && value in EVENT_TYPE_LABELS) {
    return EVENT_TYPE_LABELS[value as AcademicEventType];
  }
  return value;
};

export default async function EventDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ resultado?: string }>;
}): Promise<React.JSX.Element> {
  const { eventId } = await params;
  const { resultado } = await searchParams;

  let event: ExtractedEvent;
  try {
    event = await getEvent(eventId);
  } catch (err) {
    const notFound = err instanceof ApiError && err.status === 404;
    return (
      <>
        <p>
          <Link href="/anuncios">← Voltar aos anúncios</Link>
        </p>
        <ErrorState
          error={err}
          title={notFound ? 'Anúncio não encontrado' : 'Não foi possível carregar o anúncio'}
        />
      </>
    );
  }

  const history = event.changeHistory ?? [];
  const mentions = event.mentions ?? [];

  return (
    <>
      <p>
        <Link href="/anuncios">← Voltar aos anúncios</Link>
      </p>
      <Flash message={resultado ? RESULT_MESSAGES[resultado] : undefined} />
      <article className="card">
        <EventHeading event={event} />
        <AiNotice />
        <p>
          <strong>Data: </strong>
          <EventDate event={event} />
        </p>
        {event.dateResolution ? (
          <p className="muted">Como a data foi interpretada: {event.dateResolution.explanation}</p>
        ) : null}
        {event.description ? <p>{event.description}</p> : null}
        <SourceQuote event={event} />
        <EventFlags flags={event.flags} />
        <h2>Conflitos de calendário</h2>
        {event.conflicts && event.conflicts.length > 0 ? (
          <ConflictList conflicts={event.conflicts} />
        ) : (
          <p className="muted">Nenhum conflito encontrado.</p>
        )}
        <h2>Confiança da extração</h2>
        <ConfidenceBreakdown confidence={event.confidence} />
      </article>

      <EventActions
        event={event}
        confirm={confirmAction.bind(null, event.id)}
        edit={editAction.bind(null, event.id)}
        reject={rejectAction.bind(null, event.id)}
        publish={publishAction.bind(null, event.id)}
      />

      {mentions.length > 0 ? (
        <section className="card" aria-labelledby="mencoes">
          <h2 id="mencoes">Outras menções do mesmo anúncio</h2>
          <ul>
            {mentions.map((m) => (
              <li key={`${m.scheduledClassId}-${m.segmentIndex}`}>
                “{m.quote}”{' '}
                <span className="muted">
                  (aula {m.scheduledClassId.slice(0, 8)}, segmento {m.segmentIndex})
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card" aria-labelledby="historico">
        <h2 id="historico">Histórico de alterações</h2>
        {history.length === 0 ? (
          <p className="muted">Sem alterações desde a extração.</p>
        ) : (
          <table>
            <caption className="visually-hidden">Histórico de alterações do anúncio</caption>
            <thead>
              <tr>
                <th scope="col">Quando</th>
                <th scope="col">Campo</th>
                <th scope="col">Antes</th>
                <th scope="col">Depois</th>
                <th scope="col">Origem</th>
                <th scope="col">Motivo</th>
              </tr>
            </thead>
            <tbody>
              {history.map((c, i) => (
                <tr key={`${c.changedAt}-${c.field}-${i}`}>
                  <td>{formatDateTime(c.changedAt, event.timezone)}</td>
                  <td>{FIELD_LABELS[c.field] ?? c.field}</td>
                  <td>{valueLabel(c.field, c.previousValue)}</td>
                  <td>{valueLabel(c.field, c.newValue)}</td>
                  <td>{c.source}</td>
                  <td>{c.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" aria-labelledby="proveniencia">
        <h2 id="proveniencia">Proveniência</h2>
        <dl>
          <dt>Gravação</dt>
          <dd>{event.source.recordingSessionId}</dd>
          <dt>Transcrição</dt>
          <dd>
            <Link href={transcriptLink(event.transcriptId, event.source.segmentIndex)}>
              {event.transcriptId}
            </Link>
          </dd>
          <dt>Extrator</dt>
          <dd>
            {event.provenance
              ? `${event.provenance.extractor === 'llm' ? 'Modelo de linguagem' : 'Regras heurísticas'}${
                  event.provenance.model ? ` · ${event.provenance.model}` : ''
                }${event.provenance.promptVersion ? ` · prompt ${event.provenance.promptVersion}` : ''} · versão ${
                  event.provenance.processingVersion
                }`
              : '—'}
          </dd>
        </dl>
      </section>
    </>
  );
}
