import { formatDate } from '../lib/labels';
import { Pill } from './ui';

export function DueBadge({ dueAt, done }: { dueAt: string; done: boolean }): React.JSX.Element {
  if (done) return <span>{formatDate(dueAt)}</span>;
  const days = Math.ceil((new Date(dueAt).getTime() - Date.now()) / 86_400_000);
  if (days < 0) {
    return (
      <Pill icon="⏱" tone="danger">
        Vencida há {-days} d ({formatDate(dueAt)})
      </Pill>
    );
  }
  return (
    <Pill icon="⏳" tone={days <= 3 ? 'warning' : 'muted'}>
      {days} d restantes ({formatDate(dueAt)})
    </Pill>
  );
}
