import React from 'react';
import type { AcademicEventType } from '@ci/types';

interface EventCardProps {
  title: string;
  course: string;
  eventDate?: string;
  eventType: AcademicEventType;
  confirmationStatus: string;
  sourceClass?: string;
  onClick?: () => void;
}

export function EventCard({
  title,
  course,
  eventDate,
  eventType,
  confirmationStatus,
  sourceClass,
  onClick,
}: EventCardProps): React.JSX.Element {
  return (
    <article
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
      aria-label={`${eventType}: ${title}`}
    >
      <header>
        <span data-event-type={eventType}>{eventType}</span>
        <span data-status={confirmationStatus}>{confirmationStatus}</span>
      </header>
      <h3>{title}</h3>
      <p>{course}</p>
      {eventDate && <time dateTime={eventDate}>{eventDate}</time>}
      {sourceClass && <footer>Fonte: {sourceClass}</footer>}
    </article>
  );
}
