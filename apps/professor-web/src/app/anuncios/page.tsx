import Link from 'next/link';
import { ConfidenceBreakdown } from '@/components/ConfidenceBreakdown';
import { ConflictList } from '@/components/ConflictList';
import { EventDate, EventFlags, EventHeading, SourceQuote } from '@/components/EventSummary';
import { AiNotice, EmptyState, ErrorState } from '@/components/States';
import { getReviewQueue } from '@/lib/api';
import type { ExtractedEvent } from '@/lib/types';

export const dynamic = 'force-dynamic';

const FILTERS = [
  { status: 'awaiting_professor', label: 'Aguardando revisão' },
  { status: 'confirmed', label: 'Confirmados' },
  { status: 'published', label: 'Publicados' },
  { status: 'rejected', label: 'Rejeitados' },
] as const;

export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}): Promise<React.JSX.Element> {
  const { status: rawStatus } = await searchParams;
  const status = FILTERS.some((f) => f.status === rawStatus) ? rawStatus : 'awaiting_professor';

  let events: ExtractedEvent[] = [];
  let error: unknown = null;
  try {
    events = await getReviewQueue(status);
  } catch (err) {
    error = err;
  }

  return (
    <>
      <h1>Anúncios das suas aulas</h1>
      <AiNotice />
      <nav aria-label="Filtrar por status">
        <ul className="filters">
          {FILTERS.map((f) => (
            <li key={f.status}>
              <Link
                href={`/anuncios?status=${f.status}`}
                aria-current={f.status === status ? 'page' : undefined}
              >
                {f.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {error ? (
        <ErrorState error={error} title="Não foi possível carregar a fila de revisão" />
      ) : events.length === 0 ? (
        <EmptyState title="Nada por aqui">
          <p className="muted">Nenhum anúncio com este status no momento.</p>
        </EmptyState>
      ) : (
        <ul aria-label="Anúncios" style={{ listStyle: 'none', padding: 0 }}>
          {events.map((event) => (
            <li key={event.id}>
              <article className="card" aria-labelledby={`ev-${event.id}`}>
                <div id={`ev-${event.id}`}>
                  <EventHeading event={event} link />
                </div>
                <p>
                  <strong>Data: </strong>
                  <EventDate event={event} />
                </p>
                <SourceQuote event={event} />
                <EventFlags flags={event.flags} />
                <ConflictList conflicts={event.conflicts} />
                <ConfidenceBreakdown confidence={event.confidence} compact />
                <Link href={`/anuncios/${encodeURIComponent(event.id)}`}>
                  Revisar anúncio<span className="visually-hidden"> {event.title}</span>
                </Link>
              </article>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
