'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { reviewItemAction } from '@/app/actions';
import { formatTimestamp } from '@/lib/format';
import { GRADES, citationHref, nextReviewText } from '@/lib/revision';
import type { RevisionItem } from '@/lib/types';
import { AiBadge } from './States';

function Citations({ item }: { item: RevisionItem }): React.JSX.Element | null {
  const links = item.sourceCitations
    .map((c, i) => ({ c, i, href: citationHref(c) }))
    .filter(
      (x): x is { c: (typeof item.sourceCitations)[number]; i: number; href: string } =>
        x.href !== null,
    );
  if (links.length === 0) return null;
  return (
    <p className="small" style={{ margin: '8px 0 0' }}>
      <span className="muted">Fonte na aula: </span>
      {links.map(({ c, i, href }) => (
        <Link key={i} href={href} className="citation-chip">
          {c.startMs !== undefined
            ? `Transcrição em ${formatTimestamp(c.startMs)}`
            : `Trecho ${(c.segmentIndexes[0] ?? 0) + 1}`}
        </Link>
      ))}
    </p>
  );
}

function Grader({ itemId, suggested }: { itemId: string; suggested?: number }): React.JSX.Element {
  const groupId = useId();
  const [status, setStatus] = useState<string>('');
  const [done, setDone] = useState<number | null>(null);
  const [pending, setPending] = useState(false);

  async function grade(value: number): Promise<void> {
    setPending(true);
    setStatus('Registrando…');
    const result = await reviewItemAction(itemId, value);
    setPending(false);
    if (result.ok) {
      setDone(value);
      setStatus(`Avaliação registrada. ${nextReviewText(result.intervalDays)}`);
    } else {
      setStatus(result.message);
    }
  }

  return (
    <div role="group" aria-labelledby={`${groupId}-label`} style={{ marginTop: 12 }}>
      <p id={`${groupId}-label`} className="small" style={{ marginBottom: 6, fontWeight: 600 }}>
        Como foi lembrar disso?
      </p>
      <div className="grade-row">
        {GRADES.map((g) => (
          <button
            key={g.grade}
            type="button"
            className={`btn btn--small ${done === g.grade ? '' : 'btn--secondary'}`}
            aria-pressed={done === g.grade}
            disabled={pending}
            onClick={() => void grade(g.grade)}
            title={g.hint}
          >
            <span aria-hidden="true">{g.grade}</span>
            <span>{g.label}</span>
            {suggested === g.grade && done === null && (
              <span className="visually-hidden"> (sugerido)</span>
            )}
          </button>
        ))}
      </div>
      <p role="status" aria-live="polite" className="small" style={{ margin: '6px 0 0' }}>
        {status}
      </p>
    </div>
  );
}

function Flashcard({
  item,
}: {
  item: Extract<RevisionItem, { kind: 'flashcards' }>;
}): React.JSX.Element {
  const [flipped, setFlipped] = useState(false);
  const backId = useId();
  return (
    <>
      <div className="flashcard" data-flipped={flipped}>
        <p className="flashcard__label small muted">Frente</p>
        <p className="flashcard__text">{item.content.front}</p>
        <div id={backId} hidden={!flipped}>
          <p className="flashcard__label small muted">Verso</p>
          <p className="flashcard__text">{item.content.back}</p>
        </div>
      </div>
      <button
        type="button"
        className="btn btn--secondary"
        aria-expanded={flipped}
        aria-controls={backId}
        onClick={() => setFlipped((f) => !f)}
      >
        {flipped ? 'Esconder resposta' : 'Virar cartão e ver resposta'}
      </button>
      {flipped && <Grader itemId={item.id} />}
    </>
  );
}

function Quiz({ item }: { item: Extract<RevisionItem, { kind: 'quiz' }> }): React.JSX.Element {
  const name = useId();
  const [chosen, setChosen] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  const correct = item.content.correctOption;
  const letters = ['A', 'B', 'C', 'D'];
  return (
    <>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 8 }}>{item.content.question}</legend>
        {item.content.options.map((option, i) => {
          const id = `${name}-${i}`;
          const state = !checked ? '' : i === correct ? 'correct' : i === chosen ? 'wrong' : '';
          return (
            <div key={i} className="quiz-option" data-state={state}>
              <input
                type="radio"
                id={id}
                name={name}
                checked={chosen === i}
                disabled={checked}
                onChange={() => setChosen(i)}
              />
              <label htmlFor={id} style={{ fontWeight: 400 }}>
                <span aria-hidden="true">{letters[i]}) </span>
                {option}
                {state === 'correct' && <strong> — resposta correta</strong>}
                {state === 'wrong' && <strong> — sua resposta</strong>}
              </label>
            </div>
          );
        })}
      </fieldset>
      {!checked ? (
        <button
          type="button"
          className="btn"
          disabled={chosen === null}
          onClick={() => setChecked(true)}
          style={{ marginTop: 8 }}
        >
          Verificar resposta
        </button>
      ) : (
        <div
          className={`alert ${chosen === correct ? 'alert--success' : 'alert--error'}`}
          role="status"
          style={{ marginTop: 8 }}
        >
          <p>
            <strong>
              {chosen === correct
                ? 'Correto!'
                : `Não foi dessa vez. A resposta é ${letters[correct]}.`}
            </strong>
            {item.content.explanation !== undefined && <> {item.content.explanation}</>}
          </p>
        </div>
      )}
      {checked && <Grader itemId={item.id} suggested={chosen === correct ? 4 : 1} />}
    </>
  );
}

function ConceptReview({
  item,
}: {
  item: Extract<RevisionItem, { kind: 'concept_review' }>;
}): React.JSX.Element {
  const [shown, setShown] = useState(false);
  const defId = useId();
  return (
    <>
      <p style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>{item.content.term}</p>
      <p className="small muted">Tente explicar o conceito com suas palavras antes de conferir.</p>
      <button
        type="button"
        className="btn btn--secondary"
        aria-expanded={shown}
        aria-controls={defId}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? 'Esconder definição' : 'Conferir definição'}
      </button>
      <div id={defId} hidden={!shown} style={{ marginTop: 8 }}>
        <p style={{ margin: 0 }}>{item.content.definition}</p>
        {item.content.example !== undefined && (
          <p className="small muted">Exemplo: {item.content.example}</p>
        )}
      </div>
      {shown && <Grader itemId={item.id} />}
    </>
  );
}

export function RevisionItemCard({
  item,
  headingLevel = 3,
}: {
  item: RevisionItem;
  headingLevel?: 2 | 3;
}): React.JSX.Element {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const titles = {
    summary: 'Resumo',
    concept_review: 'Conceito',
    flashcards: 'Cartão',
    quiz: 'Questão',
  } as const;
  return (
    <article className="card revision-item" aria-label={`${titles[item.kind]} gerado por IA`}>
      <div className="btn-row" style={{ justifyContent: 'space-between' }}>
        <H style={{ margin: 0, fontSize: '1rem' }}>
          {item.kind === 'summary' ? item.content.title : titles[item.kind]}
        </H>
        <AiBadge />
      </div>
      <div style={{ marginTop: 8 }}>
        {item.kind === 'summary' && (
          <>
            <p>{item.content.executiveSummary}</p>
            {item.content.topics.length > 0 && (
              <ol className="small">
                {item.content.topics.map((t, i) => (
                  <li key={i}>
                    {t.title}
                    {typeof t.startMs === 'number' && (
                      <span className="muted"> · {formatTimestamp(t.startMs)}</span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
        {item.kind === 'concept_review' && <ConceptReview item={item} />}
        {item.kind === 'flashcards' && <Flashcard item={item} />}
        {item.kind === 'quiz' && <Quiz item={item} />}
      </div>
      <Citations item={item} />
    </article>
  );
}
