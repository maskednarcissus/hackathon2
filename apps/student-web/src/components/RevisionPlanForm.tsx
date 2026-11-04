'use client';

import { useActionState } from 'react';
import { createRevisionPlanAction, type FormState } from '@/app/actions';

export interface SectionOption {
  id: string;
  label: string;
}

export function RevisionPlanForm({
  sections,
  selectedSections,
  focus,
  from,
  to,
}: {
  sections: SectionOption[];
  selectedSections: string[];
  focus: { id: string; term: string }[];
  from: string;
  to: string;
}): React.JSX.Element {
  const [state, action, pending] = useActionState<FormState, FormData>(createRevisionPlanAction, {
    status: 'idle',
  });
  const preselectAll = selectedSections.length === 0;
  return (
    <form action={action} aria-describedby="plan-help">
      <p id="plan-help" className="small muted">
        O plano usa as aulas já processadas das disciplinas escolhidas e as suas próprias interações
        (perguntas ao assistente e revisões anteriores). Dados de outros estudantes nunca são
        usados.
      </p>
      {state.status === 'error' && (
        <div className="alert alert--error" role="alert">
          <p>{state.message}</p>
        </div>
      )}
      <fieldset>
        <legend>Disciplinas</legend>
        {sections.length === 0 ? (
          <p className="small muted">Nenhuma disciplina com aulas processadas ainda.</p>
        ) : (
          sections.map((s) => (
            <div className="btn-row" key={s.id} style={{ marginBottom: 8 }}>
              <input
                type="checkbox"
                id={`secao-${s.id}`}
                name="secao"
                value={s.id}
                defaultChecked={preselectAll || selectedSections.includes(s.id)}
              />
              <label htmlFor={`secao-${s.id}`} style={{ fontWeight: 400 }}>
                {s.label}
              </label>
            </div>
          ))
        )}
      </fieldset>
      <div className="grid grid--2">
        <div className="field">
          <label htmlFor="rev-de">
            Aulas a partir de <span className="field-hint">(opcional)</span>
          </label>
          <input id="rev-de" name="de" type="date" defaultValue={from} />
        </div>
        <div className="field">
          <label htmlFor="rev-ate">
            Até <span className="field-hint">(opcional)</span>
          </label>
          <input id="rev-ate" name="ate" type="date" defaultValue={to} />
        </div>
      </div>
      {focus.length > 0 && (
        <fieldset>
          <legend>Conceitos em foco</legend>
          <p className="small muted" style={{ marginTop: 0 }}>
            Escolhidos nas páginas das aulas. Desmarque para retirar.
          </p>
          {focus.map((f) => (
            <div className="btn-row" key={f.id} style={{ marginBottom: 8 }}>
              <input type="checkbox" id={`foco-${f.id}`} name="foco" value={f.id} defaultChecked />
              <label htmlFor={`foco-${f.id}`} style={{ fontWeight: 400 }}>
                {f.term}
              </label>
            </div>
          ))}
        </fieldset>
      )}
      <button
        type="submit"
        className="btn"
        disabled={pending || sections.length === 0}
        aria-busy={pending}
      >
        {pending ? 'Gerando plano… (pode levar até um minuto)' : 'Gerar plano de revisão'}
      </button>
      <p role="status" aria-live="polite" className="visually-hidden">
        {pending ? 'Gerando plano de revisão.' : ''}
      </p>
    </form>
  );
}
