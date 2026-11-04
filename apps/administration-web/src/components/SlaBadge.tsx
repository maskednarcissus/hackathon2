import { formatDateTime } from '../lib/format';
import { Pill } from './ui';

export function SlaBadge({
  dueAt,
  breached,
  resolved,
}: {
  dueAt: string;
  breached: boolean;
  resolved: boolean;
}): React.JSX.Element {
  if (breached) {
    return (
      <Pill icon="⏱" tone="danger">
        SLA estourado ({formatDateTime(dueAt)})
      </Pill>
    );
  }
  if (resolved) return <span className="muted">Dentro do SLA</span>;
  const minutes = Math.round((new Date(dueAt).getTime() - Date.now()) / 60_000);
  const left = minutes < 60 ? `${Math.max(0, minutes)} min` : `${Math.round(minutes / 60)} h`;
  return (
    <Pill icon="⏳" tone={minutes < 60 ? 'warning' : 'muted'}>
      Vence em {left}
    </Pill>
  );
}
