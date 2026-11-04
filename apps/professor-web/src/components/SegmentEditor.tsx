'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import type { CorrectionState } from '@/app/aulas/[transcriptId]/transcricao/actions';

type BoundAction = (prev: CorrectionState, form: FormData) => Promise<CorrectionState>;

function SaveButton(): React.JSX.Element {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-disabled={pending}>
      {pending ? 'Salvando…' : 'Salvar correção'}
    </button>
  );
}

export function SegmentEditor({
  segmentIndex,
  text,
  action,
}: {
  segmentIndex: number;
  text: string;
  action: BoundAction;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [state, formAction] = useActionState(action, {});

  useEffect(() => {
    if (state.ok) setEditing(false);
  }, [state]);

  if (!editing) {
    return (
      <div>
        {state.ok ? (
          <span role="status" className="muted">
            Correção salva.{' '}
          </span>
        ) : null}
        <button type="button" className="secondary" onClick={() => setEditing(true)}>
          Corrigir<span className="visually-hidden"> segmento {segmentIndex}</span>
        </button>
      </div>
    );
  }

  const fieldId = `correction-${segmentIndex}`;
  return (
    <form action={formAction} className="stack">
      <label htmlFor={fieldId}>Texto corrigido</label>
      <textarea
        id={fieldId}
        name="correctedText"
        defaultValue={text}
        required
        maxLength={5000}
        autoFocus
      />
      <label>
        Motivo (opcional)
        <input name="reason" maxLength={500} placeholder="Ex.: termo técnico transcrito errado" />
      </label>
      {state.error ? (
        <p role="alert" className="field-error">
          {state.error}
        </p>
      ) : null}
      <div className="actions">
        <SaveButton />
        <button type="button" className="secondary" onClick={() => setEditing(false)}>
          Cancelar
        </button>
      </div>
      <p className="muted">A versão original gerada pela máquina é preservada.</p>
    </form>
  );
}
