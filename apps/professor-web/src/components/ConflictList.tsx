import { CONFLICT_SEVERITY_LABELS } from '@/lib/format';
import type { CalendarConflict } from '@/lib/types';

const ICON: Record<CalendarConflict['severity'], string> = {
  blocking: '⛔',
  warning: '⚠️',
  info: 'ℹ️',
};

export function ConflictList({
  conflicts,
}: {
  conflicts: CalendarConflict[] | undefined;
}): React.JSX.Element | null {
  if (!conflicts || conflicts.length === 0) return null;
  return (
    <ul className="conflicts" aria-label="Conflitos de calendário">
      {conflicts.map((c, i) => (
        <li key={`${c.kind}-${i}`} className={`conflict conflict-${c.severity}`}>
          <span aria-hidden="true">{ICON[c.severity]}</span>{' '}
          <strong>{CONFLICT_SEVERITY_LABELS[c.severity]}:</strong> {c.message}
        </li>
      ))}
    </ul>
  );
}
