'use client';

import { startTransition, useActionState, useEffect, useRef } from 'react';
import type { ActionState } from '../lib/action-state';

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

/**
 * Form bound to a Server Action, with accessible pending/success/error feedback.
 * Submits through a transition (instead of the `action` prop) so React does not reset the
 * fields on a validation error; the form is cleared only after a successful action.
 */
export function ActionForm({
  action,
  submitLabel,
  tone,
  confirm,
  className = 'actionForm',
  children,
}: {
  action: Action;
  submitLabel: string;
  tone?: 'danger' | 'secondary';
  /** Native confirmation prompt for destructive actions. */
  confirm?: string;
  className?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const [state, dispatch, pending] = useActionState(action, {});
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.message) formRef.current?.reset();
  }, [state]);

  return (
    <form
      ref={formRef}
      className={className}
      aria-busy={pending}
      onSubmit={(e) => {
        e.preventDefault();
        if (pending) return;
        if (confirm && !window.confirm(confirm)) return;
        const data = new FormData(e.currentTarget);
        startTransition(() => dispatch(data));
      }}
    >
      {children}
      <button
        type="submit"
        className={`button ${tone ?? ''}`}
        disabled={pending}
        aria-disabled={pending}
      >
        {pending ? 'Enviando…' : submitLabel}
      </button>
      {state.error ? (
        <p role="alert" className="formError">
          {state.error}
        </p>
      ) : null}
      {state.message ? (
        <p role="status" className="formOk">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
