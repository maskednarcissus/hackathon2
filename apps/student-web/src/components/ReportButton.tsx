'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { submitReportAction, type FormState } from '@/app/actions';
import type { ReportReason, ReportResourceType } from '@/lib/types';
import { Icon } from './Icon';

const REASONS: { value: ReportReason; label: string }[] = [
  { value: 'incorrect_content', label: 'Conteúdo incorreto' },
  { value: 'incorrect_date', label: 'Data ou prazo incorreto' },
  { value: 'misattributed_statement', label: 'Atribuído ao professor sem ele ter dito' },
  { value: 'transcription_error', label: 'Erro de transcrição' },
  { value: 'other', label: 'Outro motivo' },
];

interface Target {
  resourceType: ReportResourceType;
  resourceId: string;
  classSectionId?: string | undefined;
  /** Short description of what is being reported, used in the accessible name. */
  context: string;
}

/** Native <dialog> (focus trap + Esc handled by the browser); returns focus to `returnFocus`. */
function ReportDialog({
  target,
  dialogRef,
  returnFocus,
}: {
  target: Target;
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  returnFocus: () => void;
}): React.JSX.Element {
  const { resourceType, resourceId, classSectionId, context } = target;
  const titleId = useId();
  const [state, action, pending] = useActionState<FormState, FormData>(submitReportAction, {
    status: 'idle',
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    dialog.addEventListener('close', returnFocus);
    return (): void => dialog.removeEventListener('close', returnFocus);
  }, [dialogRef, returnFocus]);

  return (
    <dialog ref={dialogRef} aria-labelledby={titleId}>
      <h2 id={titleId}>Reportar informação incorreta</h2>
      <p className="muted small">Sobre: {context}</p>
      {state.status === 'success' ? (
        <>
          <div className="alert alert--success" role="status">
            <p>{state.message}</p>
          </div>
          <button type="button" className="btn" onClick={() => dialogRef.current?.close()}>
            Fechar
          </button>
        </>
      ) : (
        <form action={action}>
          <input type="hidden" name="resourceType" value={resourceType} />
          <input type="hidden" name="resourceId" value={resourceId} />
          <input type="hidden" name="classSectionId" value={classSectionId ?? ''} />
          {state.status === 'error' && (
            <div className="alert alert--error" role="alert">
              <p>{state.message}</p>
            </div>
          )}
          <fieldset>
            <legend>Qual é o problema?</legend>
            {REASONS.map((r, i) => (
              <div className="btn-row" key={r.value} style={{ marginBottom: 8 }}>
                <input
                  type="radio"
                  id={`${titleId}-${r.value}`}
                  name="reason"
                  value={r.value}
                  required
                  defaultChecked={i === 0}
                />
                <label htmlFor={`${titleId}-${r.value}`} style={{ fontWeight: 400 }}>
                  {r.label}
                </label>
              </div>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor={`${titleId}-details`}>
              Detalhes <span className="field-hint">(opcional, exceto em “Outro motivo”)</span>
            </label>
            <textarea id={`${titleId}-details`} name="details" maxLength={2000} />
          </div>
          <div className="btn-row">
            <button type="submit" className="btn" disabled={pending}>
              {pending ? 'Enviando…' : 'Enviar'}
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => dialogRef.current?.close()}
            >
              Cancelar
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

/** "Reportar informação incorreta" button + dialog. */
export function ReportButton(target: Target): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn--ghost btn--small"
        onClick={() => dialogRef.current?.showModal()}
        aria-label={`Reportar informação incorreta: ${target.context}`}
      >
        <Icon name="flag" />
        <span aria-hidden="true">Reportar</span>
      </button>
      <ReportDialog
        target={target}
        dialogRef={dialogRef}
        returnFocus={() => triggerRef.current?.focus()}
      />
    </>
  );
}

/**
 * One shared dialog for long lists (transcripts): server-rendered buttons carry
 * `data-report-id` / `data-report-context`; a delegated listener opens the dialog.
 */
export function DelegatedReportDialog({
  resourceType,
  classSectionId,
}: {
  resourceType: ReportResourceType;
  classSectionId?: string | undefined;
}): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const lastTrigger = useRef<HTMLElement | null>(null);
  const [target, setTarget] = useState<Target | null>(null);

  useEffect(() => {
    function onClick(event: MouseEvent): void {
      const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-report-id]');
      if (el === null || el === undefined) return;
      lastTrigger.current = el;
      setTarget({
        resourceType,
        resourceId: el.dataset['reportId'] ?? '',
        classSectionId,
        context: el.dataset['reportContext'] ?? 'trecho',
      });
    }
    document.addEventListener('click', onClick);
    return (): void => document.removeEventListener('click', onClick);
  }, [resourceType, classSectionId]);

  useEffect(() => {
    if (target !== null && dialogRef.current?.open !== true) dialogRef.current?.showModal();
  }, [target]);

  if (target === null) return null;
  return (
    <ReportDialog
      key={target.resourceId}
      target={target}
      dialogRef={dialogRef}
      returnFocus={() => lastTrigger.current?.focus()}
    />
  );
}
