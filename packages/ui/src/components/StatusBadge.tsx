import React from 'react';

export type EventStatus =
  | 'suggested'
  | 'awaiting_professor'
  | 'awaiting_admin'
  | 'confirmed'
  | 'published'
  | 'modified'
  | 'cancelled'
  | 'rejected';

const statusLabels: Record<EventStatus, string> = {
  suggested: 'Sugerido',
  awaiting_professor: 'Aguardando professor',
  awaiting_admin: 'Aguardando administrador',
  confirmed: 'Confirmado',
  published: 'Publicado',
  modified: 'Modificado',
  cancelled: 'Cancelado',
  rejected: 'Rejeitado',
};

interface StatusBadgeProps {
  status: EventStatus;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps): React.JSX.Element {
  return (
    <span
      className={className}
      data-status={status}
      aria-label={statusLabels[status]}
      role="status"
    >
      {statusLabels[status]}
    </span>
  );
}
