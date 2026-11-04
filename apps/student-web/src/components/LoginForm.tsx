'use client';

import { useActionState } from 'react';
import { loginAction, type FormState } from '@/app/actions';

export function LoginForm({
  next,
  askInstitution,
}: {
  next: string;
  askInstitution: boolean;
}): React.JSX.Element {
  const [state, action, pending] = useActionState<FormState, FormData>(loginAction, {
    status: 'idle',
  });
  return (
    <form action={action} noValidate>
      <input type="hidden" name="next" value={next} />
      {state.status === 'error' && (
        <div className="alert alert--error" role="alert" id="login-error">
          <p>{state.message}</p>
        </div>
      )}
      <div className="field">
        <label htmlFor="email">E-mail institucional</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          required
          aria-describedby={state.status === 'error' ? 'login-error' : undefined}
        />
      </div>
      <div className="field">
        <label htmlFor="password">Senha</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      {askInstitution && (
        <div className="field">
          <label htmlFor="institutionId">
            Código da instituição
            <span className="field-hint"> — informado pela secretaria</span>
          </label>
          <input
            id="institutionId"
            name="institutionId"
            type="text"
            required
            autoComplete="organization"
          />
        </div>
      )}
      <button type="submit" className="btn" disabled={pending} aria-busy={pending}>
        {pending ? 'Entrando…' : 'Entrar'}
      </button>
    </form>
  );
}
