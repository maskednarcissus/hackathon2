import type { Metadata } from 'next';
import { PreferencesForm } from '@/components/PreferencesForm';
import { PushOptIn } from '@/components/PushOptIn';
import { ErrorState } from '@/components/States';
import { notifications } from '@/lib/api';
import { guard } from '@/lib/http';
import { requireSession } from '@/lib/session';
import type { NotificationPreferences } from '@/lib/types';

export const metadata: Metadata = { title: 'Preferências' };

const DEFAULTS: NotificationPreferences = {
  categories: {
    new_assessment: { in_app: true, email: true, push: true },
    deadline_change: { in_app: true, email: true, push: true },
    class_cancellation: { in_app: true, email: true, push: true },
    lecture_summary: { in_app: true, email: false, push: false },
    reminder: { in_app: true, email: false, push: true },
  },
  quietHours: { start: '22:00', end: '07:00', timezone: 'America/Sao_Paulo' },
  reminderOffsetsHours: [24, 2],
};

export default async function PreferencesPage(): Promise<React.JSX.Element> {
  const session = await requireSession();
  const result = guard(await notifications.preferences(session.userId));
  // A 404 means the student never saved preferences: start from the defaults.
  const initial = result.ok
    ? {
        ...DEFAULTS,
        ...result.data,
        categories: { ...DEFAULTS.categories, ...result.data.categories },
      }
    : DEFAULTS;
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Preferências de notificação</h1>
          <p>Escolha quais avisos receber e por qual canal.</p>
        </div>
      </div>
      {!result.ok && result.status !== 404 ? (
        <ErrorState message={result.message} />
      ) : (
        <div className="stack">
          <PreferencesForm initial={initial} />
          <PushOptIn />
        </div>
      )}
    </>
  );
}
