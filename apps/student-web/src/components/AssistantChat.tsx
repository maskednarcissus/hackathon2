'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { askAssistantAction, assistantFeedbackAction } from '@/app/actions';
import { formatTimestamp } from '@/lib/format';
import type { AssistantAnswer, Citation, Refusal } from '@/lib/types';
import { AiBadge } from './States';
import { ReportButton } from './ReportButton';

interface Turn {
  id: string;
  question: string;
  answer?: AssistantAnswer;
  error?: string;
}

const REFUSALS: Record<Refusal, string> = {
  no_evidence:
    'Não encontrei esse assunto nas aulas das suas turmas. Tente reformular ou pergunte ao professor.',
  out_of_scope: 'Só posso responder perguntas sobre o conteúdo das suas aulas.',
  injection_suspected:
    'Não consegui processar essa pergunta com segurança. Reformule usando apenas sua dúvida sobre a aula.',
};

function citationHref(c: Citation): string {
  return `/aulas/${encodeURIComponent(c.scheduledClassId)}/transcricao?t=${c.startMs}#s-${c.segmentIndex}`;
}

function citationLabel(c: Citation, n: number): string {
  const where = [c.courseName, c.classDate].filter(Boolean).join(', ');
  return `[${n}] ${where !== '' ? `${where} · ` : ''}${formatTimestamp(c.startMs)}`;
}

function Feedback({ answerId }: { answerId: string }): React.JSX.Element {
  const [sent, setSent] = useState<null | boolean>(null);
  async function send(helpful: boolean): Promise<void> {
    const ok = await assistantFeedbackAction(answerId, helpful);
    setSent(ok ? helpful : null);
  }
  return (
    <div className="btn-row small">
      <span className="muted">Esta resposta ajudou?</span>
      <button
        type="button"
        className="btn btn--secondary btn--small"
        aria-pressed={sent === true}
        onClick={() => void send(true)}
      >
        Sim
      </button>
      <button
        type="button"
        className="btn btn--secondary btn--small"
        aria-pressed={sent === false}
        onClick={() => void send(false)}
      >
        Não
      </button>
      <span role="status" aria-live="polite">
        {sent !== null ? 'Obrigado pelo retorno.' : ''}
      </span>
    </div>
  );
}

function AnswerView({ answer }: { answer: AssistantAnswer }): React.JSX.Element {
  const indexById = new Map(answer.citations.map((c, i) => [c.id, i + 1]));
  if (answer.refusal !== null) {
    return (
      <div className="alert alert--info">
        <p>{REFUSALS[answer.refusal]}</p>
      </div>
    );
  }
  return (
    <div>
      {answer.answer.map((block, i) => {
        const cited = block.citationIds
          .map((id) => answer.citations.find((c) => c.id === id))
          .filter((c): c is Citation => c !== undefined);
        // A professor statement without a verbatim citation is never shown as such (contract §4).
        const isProfessor = block.kind === 'professor_statement' && cited.length > 0;
        return (
          <div
            key={i}
            className={`answer-block ${isProfessor ? 'answer-block--professor' : 'answer-block--ai'}`}
          >
            {isProfessor ? (
              <span className="badge badge--info">Dito em aula</span>
            ) : (
              <AiBadge label="Explicação gerada por IA" />
            )}
            <p style={{ marginTop: 8 }}>{block.text}</p>
            {cited.length > 0 && (
              <p className="small" style={{ marginBottom: 0 }}>
                <span className="muted">Fontes: </span>
                {cited.map((c) => (
                  <Link key={c.id} href={citationHref(c)} className="citation-chip">
                    {citationLabel(c, indexById.get(c.id) ?? 0)}
                  </Link>
                ))}
              </p>
            )}
          </div>
        );
      })}
      {answer.citations.length > 0 && (
        <details>
          <summary>Trechos citados ({answer.citations.length})</summary>
          <ol>
            {answer.citations.map((c) => (
              <li key={c.id}>
                <blockquote className="quote">“{c.quote}”</blockquote>
                <Link href={citationHref(c)}>
                  Abrir na transcrição em {formatTimestamp(c.startMs)}
                </Link>
              </li>
            ))}
          </ol>
        </details>
      )}
      {!answer.grounded && (
        <p className="small muted">
          Parte desta resposta não está diretamente apoiada nas transcrições. Confira com o material
          da disciplina.
        </p>
      )}
    </div>
  );
}

export function AssistantChat({
  scheduledClassId,
}: {
  scheduledClassId?: string;
}): React.JSX.Element {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const conversationId = useRef<string | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const q = question.trim();
    if (q === '' || pending) return;
    const id = `${Date.now()}`;
    setTurns((t) => [...t, { id, question: q }]);
    setQuestion('');
    setPending(true);
    setStatus('Buscando nas suas aulas…');
    const result = await askAssistantAction({
      question: q,
      ...(conversationId.current !== undefined ? { conversationId: conversationId.current } : {}),
      ...(scheduledClassId !== undefined ? { scheduledClassId } : {}),
    });
    setPending(false);
    if (result.ok) {
      conversationId.current = result.answer.conversationId;
      setTurns((t) =>
        t.map((turn) => (turn.id === id ? { ...turn, answer: result.answer } : turn)),
      );
      setStatus('Resposta recebida.');
    } else {
      setTurns((t) =>
        t.map((turn) => (turn.id === id ? { ...turn, error: result.message } : turn)),
      );
      setStatus('Não foi possível obter a resposta.');
    }
    inputRef.current?.focus();
  }

  return (
    <div className="chat">
      {turns.length === 0 && (
        <div className="card">
          <p>
            Pergunte sobre o conteúdo das suas aulas. As respostas citam o trecho da transcrição de
            onde vieram. O que é <strong>dito em aula</strong> aparece separado do que é{' '}
            <strong>explicação gerada por IA</strong>.
          </p>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Exemplos: “O que é a curva IS-LM?”, “Quando é a próxima prova de Cálculo?”
          </p>
        </div>
      )}
      <ol className="list-plain chat" aria-label="Conversa com o assistente">
        {turns.map((turn) => (
          <li key={turn.id} className="stack" style={{ border: 0 }}>
            <div className="chat-turn--user">
              <span className="visually-hidden">Você perguntou: </span>
              {turn.question}
            </div>
            <div className="chat-turn--assistant card">
              <h2 className="visually-hidden">Resposta do assistente</h2>
              {turn.answer !== undefined ? (
                <>
                  <AnswerView answer={turn.answer} />
                  <div
                    className="btn-row"
                    style={{ justifyContent: 'space-between', marginTop: 8 }}
                  >
                    <Feedback answerId={turn.answer.answerId} />
                    <ReportButton
                      resourceType="assistant_answer"
                      resourceId={turn.answer.answerId}
                      context={`resposta para “${turn.question.slice(0, 60)}”`}
                    />
                  </div>
                </>
              ) : turn.error !== undefined ? (
                <div className="alert alert--error" role="alert">
                  <p>{turn.error}</p>
                </div>
              ) : (
                <p className="muted">Buscando nas suas aulas…</p>
              )}
            </div>
          </li>
        ))}
      </ol>
      <p className="visually-hidden" role="status" aria-live="polite">
        {status}
      </p>
      <form className="composer" onSubmit={(e) => void submit(e)}>
        <label htmlFor="question" className="visually-hidden">
          Sua pergunta
        </label>
        <textarea
          id="question"
          ref={inputRef}
          value={question}
          maxLength={2000}
          placeholder="Escreva sua pergunta sobre as aulas…"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button type="submit" className="btn" disabled={pending || question.trim() === ''}>
          Enviar
        </button>
      </form>
    </div>
  );
}
