import Link from 'next/link';
import {
  EVENT_TYPE_LABELS,
  STATUS_LABELS,
  flagLabel,
  formatDate,
  formatTimestamp,
  transcriptLink,
} from '@/lib/format';
import type { ExtractedEvent } from '@/lib/types';

export function EventDate({ event }: { event: ExtractedEvent }): React.JSX.Element {
  if (!event.eventDate) {
    return (
      <span className="tag tag-warning">
        Data ambígua{event.dateExpression ? ` — “${event.dateExpression}”` : ''}
      </span>
    );
  }
  return (
    <span>
      {formatDate(event.eventDate)}
      {event.eventTime ? ` às ${event.eventTime}` : ''}
      {event.dateResolution?.ambiguous ? (
        <span className="tag tag-warning"> data a confirmar</span>
      ) : null}
    </span>
  );
}

export function EventFlags({ flags }: { flags: string[] }): React.JSX.Element | null {
  if (flags.length === 0) return null;
  return (
    <ul className="filters" aria-label="Alertas da extração">
      {flags.map((f) => (
        <li
          key={f}
          className={`tag ${f === 'injection_suspected' || f === 'hypothetical' ? 'tag-danger' : 'tag-warning'}`}
        >
          {flagLabel(f)}
        </li>
      ))}
    </ul>
  );
}

export function SourceQuote({ event }: { event: ExtractedEvent }): React.JSX.Element {
  const { source } = event;
  return (
    <blockquote className="quote">
      “{source.quote}”
      <cite>
        Trecho transcrito da aula em{' '}
        <Link href={transcriptLink(event.transcriptId, source.segmentIndex)}>
          {formatTimestamp(source.startMs)}–{formatTimestamp(source.endMs)}
        </Link>{' '}
        (segmento {source.segmentIndex})
      </cite>
    </blockquote>
  );
}

export function EventHeading({
  event,
  link = false,
}: {
  event: ExtractedEvent;
  link?: boolean;
}): React.JSX.Element {
  return (
    <header>
      <div>
        <span className="tag">{EVENT_TYPE_LABELS[event.type]}</span>
        {link ? (
          <h2 style={{ display: 'inline' }}>
            <Link href={`/anuncios/${encodeURIComponent(event.id)}`}>{event.title}</Link>
          </h2>
        ) : (
          <h1 style={{ display: 'inline' }}>{event.title}</h1>
        )}
      </div>
      <span className="muted">{STATUS_LABELS[event.confirmationStatus]}</span>
    </header>
  );
}
