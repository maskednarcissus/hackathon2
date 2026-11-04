import Link from 'next/link';
import { EVENT_TYPE_LABELS, eventStatus, formatDateLong } from '@/lib/format';
import type { CalendarEvent } from '@/lib/types';
import { StatusBadge } from './States';

export function EventItem({
  event,
  showDate = true,
}: {
  event: CalendarEvent;
  showDate?: boolean;
}): React.JSX.Element {
  const status = eventStatus(event);
  return (
    <Link href={`/calendario/${encodeURIComponent(event.id)}`} className="list-item">
      <span className="list-item__title">{event.title}</span>
      <span className="meta">
        <span>{EVENT_TYPE_LABELS[event.type] ?? 'Evento'}</span>
        {event.courseName ? <span>{event.courseName}</span> : null}
        {showDate && (
          <span>
            {event.eventDate !== null ? formatDateLong(event.eventDate) : 'Data a confirmar'}
            {event.eventTime ? ` às ${event.eventTime}` : ''}
          </span>
        )}
        <StatusBadge {...status} />
      </span>
    </Link>
  );
}
