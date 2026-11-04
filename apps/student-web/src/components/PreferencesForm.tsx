'use client';

import { useActionState, useState } from 'react';
import { savePreferencesAction, type FormState } from '@/app/actions';
import type { NotificationCategory, NotificationPreferences } from '@/lib/types';

const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  new_assessment: 'Nova avaliação ou prazo',
  deadline_change: 'Prazo alterado',
  class_cancellation: 'Aula cancelada',
  lecture_summary: 'Resumo da aula disponível',
  reminder: 'Lembretes de avaliações',
};
const CRITICAL: ReadonlySet<NotificationCategory> = new Set([
  'deadline_change',
  'class_cancellation',
]);
const CHANNELS = [
  { key: 'in_app', label: 'No aplicativo' },
  { key: 'email', label: 'E-mail' },
  { key: 'push', label: 'Push' },
] as const;
const REMINDER_OPTIONS = [
  { hours: 168, label: '1 semana antes' },
  { hours: 72, label: '3 dias antes' },
  { hours: 24, label: '1 dia antes' },
  { hours: 2, label: '2 horas antes' },
];

export function PreferencesForm({
  initial,
}: {
  initial: NotificationPreferences;
}): React.JSX.Element {
  const [state, action, pending] = useActionState<FormState, FormData>(savePreferencesAction, {
    status: 'idle',
  });
  const [quiet, setQuiet] = useState(initial.quietHours !== null);
  const categories = Object.keys(CATEGORY_LABELS) as NotificationCategory[];

  return (
    <form action={action}>
      <section className="card" aria-labelledby="channels-title">
        <h2 id="channels-title">Como você quer ser avisado</h2>
        <div style={{ overflowX: 'auto' }}>
          <table className="pref-table">
            <caption className="visually-hidden">Canais de notificação por tipo de aviso</caption>
            <thead>
              <tr>
                <th scope="col">Tipo de aviso</th>
                {CHANNELS.map((c) => (
                  <th scope="col" key={c.key}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {categories.map((category) => {
                const toggles = initial.categories[category] ?? {
                  in_app: true,
                  email: false,
                  push: false,
                };
                return (
                  <tr key={category}>
                    <th scope="row">
                      {CATEGORY_LABELS[category]}
                      {CRITICAL.has(category) && (
                        <span className="field-hint" id={`${category}-locked`}>
                          <br />
                          Aviso no aplicativo sempre ativo (informação crítica)
                        </span>
                      )}
                    </th>
                    {CHANNELS.map((channel) => {
                      const locked = channel.key === 'in_app' && CRITICAL.has(category);
                      const id = `${category}.${channel.key}`;
                      return (
                        <td key={channel.key}>
                          <label htmlFor={id} className="visually-hidden">
                            {`${CATEGORY_LABELS[category]} — ${channel.label}`}
                          </label>
                          <input
                            type="checkbox"
                            id={id}
                            name={id}
                            defaultChecked={locked || toggles[channel.key]}
                            disabled={locked}
                            aria-describedby={locked ? `${category}-locked` : undefined}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-labelledby="quiet-title">
        <h2 id="quiet-title">Horário de silêncio</h2>
        <p className="muted small">E-mails e notificações push ficam para depois desse período.</p>
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <input
            type="checkbox"
            id="quietEnabled"
            name="quietEnabled"
            checked={quiet}
            onChange={(e) => setQuiet(e.target.checked)}
          />
          <label htmlFor="quietEnabled">Ativar horário de silêncio</label>
        </div>
        {quiet && (
          <div className="grid grid--2">
            <div className="field">
              <label htmlFor="quietStart">Início</label>
              <input
                type="time"
                id="quietStart"
                name="quietStart"
                defaultValue={initial.quietHours?.start ?? '22:00'}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="quietEnd">Fim</label>
              <input
                type="time"
                id="quietEnd"
                name="quietEnd"
                defaultValue={initial.quietHours?.end ?? '07:00'}
                required
              />
            </div>
          </div>
        )}
        <input
          type="hidden"
          name="timezone"
          value={initial.quietHours?.timezone ?? 'America/Sao_Paulo'}
        />
      </section>

      <section className="card">
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>
            <h2 style={{ margin: 0 }}>Lembretes antes de avaliações</h2>
          </legend>
          {REMINDER_OPTIONS.map((option) => (
            <div className="btn-row" key={option.hours} style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                id={`reminder-${option.hours}`}
                name="reminder"
                value={option.hours}
                defaultChecked={initial.reminderOffsetsHours.includes(option.hours)}
              />
              <label htmlFor={`reminder-${option.hours}`} style={{ fontWeight: 400 }}>
                {option.label}
              </label>
            </div>
          ))}
        </fieldset>
      </section>

      <div className="btn-row" style={{ marginTop: 16 }}>
        <button type="submit" className="btn" disabled={pending}>
          {pending ? 'Salvando…' : 'Salvar preferências'}
        </button>
        <span role="status" aria-live="polite">
          {state.status === 'success' ? state.message : ''}
        </span>
      </div>
      {state.status === 'error' && (
        <div className="alert alert--error" role="alert" style={{ marginTop: 12 }}>
          <p>{state.message}</p>
        </div>
      )}
    </form>
  );
}
