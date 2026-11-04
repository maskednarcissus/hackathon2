'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionState } from '@/app/anuncios/actions';
import { EVENT_TYPE_LABELS } from '@/lib/format';
import { EVENT_TYPES, type ExtractedEvent } from '@/lib/types';

type BoundAction = (prev: ActionState, form: FormData) => Promise<ActionState>;

function Submit({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-disabled={pending}>
      {pending ? 'Enviando…' : children}
    </button>
  );
}

function FormError({ state }: { state: ActionState }): React.JSX.Element | null {
  if (!state.error) return null;
  return (
    <p role="alert" className="field-error">
      {state.error}
    </p>
  );
}

function FieldError({
  state,
  name,
}: {
  state: ActionState;
  name: string;
}): React.JSX.Element | null {
  const message = state.fieldErrors?.[name];
  if (!message) return null;
  return (
    <span id={`${name}-error`} className="field-error">
      {message}
    </span>
  );
}

const describedBy = (state: ActionState, name: string): string | undefined =>
  state.fieldErrors?.[name] ? `${name}-error` : undefined;

export function EventActions({
  event,
  confirm,
  edit,
  reject,
  publish,
}: {
  event: ExtractedEvent;
  confirm: BoundAction;
  edit: BoundAction;
  reject: BoundAction;
  publish: BoundAction;
}): React.JSX.Element {
  const [confirmState, confirmFormAction] = useActionState(confirm, {});
  const [editState, editFormAction] = useActionState(edit, {});
  const [rejectState, rejectFormAction] = useActionState(reject, {});
  const [publishState, publishFormAction] = useActionState(publish, {});

  const status = event.confirmationStatus;
  const reviewable =
    status === 'suggested' || status === 'awaiting_professor' || status === 'awaiting_admin';
  const canConfirm = reviewable && event.eventDate !== null;
  const canPublish = status === 'confirmed';
  const canEdit = status !== 'rejected' && status !== 'published';
  const canReject = status !== 'rejected' && status !== 'published';

  return (
    <section aria-labelledby="acoes" className="card">
      <h2 id="acoes">Sua decisão</h2>
      {status === 'published' ? (
        <p>Este anúncio já foi publicado no calendário dos alunos.</p>
      ) : null}
      {status === 'rejected' ? <p>Este anúncio foi rejeitado e não será publicado.</p> : null}

      <div className="actions">
        {reviewable ? (
          <form action={confirmFormAction} className="stack">
            <label>
              Observação (opcional)
              <input name="notes" maxLength={500} />
            </label>
            {!canConfirm ? (
              <p className="field-error">
                A data não foi determinada. Use “Editar e confirmar” para informá-la.
              </p>
            ) : null}
            <FormError state={confirmState} />
            <div>{canConfirm ? <Submit>Confirmar anúncio</Submit> : null}</div>
          </form>
        ) : null}

        {canPublish ? (
          <form action={publishFormAction}>
            <FormError state={publishState} />
            <Submit>Publicar no calendário</Submit>
          </form>
        ) : null}
      </div>

      {canEdit ? (
        <details
          open={
            event.eventDate === null || Boolean(editState.fieldErrors) || Boolean(editState.error)
          }
        >
          <summary>Editar e confirmar</summary>
          <form action={editFormAction} className="stack" noValidate>
            <label>
              Título
              <input
                name="title"
                defaultValue={event.title}
                required
                maxLength={500}
                aria-invalid={Boolean(editState.fieldErrors?.title)}
                aria-describedby={describedBy(editState, 'title')}
              />
              <FieldError state={editState} name="title" />
            </label>
            <label>
              Tipo
              <select
                name="type"
                defaultValue={event.type}
                aria-describedby={describedBy(editState, 'type')}
              >
                {EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {EVENT_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
              <FieldError state={editState} name="type" />
            </label>
            <label>
              Data
              <input
                type="date"
                name="eventDate"
                defaultValue={event.eventDate ?? ''}
                aria-invalid={Boolean(editState.fieldErrors?.eventDate)}
                aria-describedby={describedBy(editState, 'eventDate')}
              />
              <FieldError state={editState} name="eventDate" />
            </label>
            <label>
              Horário (opcional)
              <input
                type="time"
                name="eventTime"
                defaultValue={event.eventTime ?? ''}
                aria-describedby={describedBy(editState, 'eventTime')}
              />
              <FieldError state={editState} name="eventTime" />
            </label>
            <label>
              Descrição
              <textarea
                name="description"
                defaultValue={event.description ?? ''}
                maxLength={2000}
              />
            </label>
            <label>
              Motivo da alteração (opcional)
              <input name="reason" maxLength={500} />
            </label>
            <FormError state={editState} />
            <div>
              <Submit>Salvar alterações e confirmar</Submit>
            </div>
          </form>
        </details>
      ) : null}

      {canReject ? (
        <details open={Boolean(rejectState.fieldErrors) || Boolean(rejectState.error)}>
          <summary>Rejeitar anúncio</summary>
          <form action={rejectFormAction} className="stack" noValidate>
            <label>
              Motivo (obrigatório)
              <textarea
                name="reason"
                required
                minLength={3}
                maxLength={1000}
                aria-invalid={Boolean(rejectState.fieldErrors?.reason)}
                aria-describedby={describedBy(rejectState, 'reason')}
              />
              <FieldError state={rejectState} name="reason" />
            </label>
            <FormError state={rejectState} />
            <div>
              <Submit className="danger">Rejeitar</Submit>
            </div>
          </form>
        </details>
      ) : null}
    </section>
  );
}
