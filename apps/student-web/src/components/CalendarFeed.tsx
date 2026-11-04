'use client';

import { useState } from 'react';
import { createCalendarFeedAction } from '@/app/actions';

/** Generates the private ICS subscription URL (Google/Apple/Outlook) and offers copy. */
export function CalendarFeed(): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);

  async function generate(): Promise<void> {
    setPending(true);
    setError(null);
    setCopied(false);
    const result = await createCalendarFeedAction();
    setPending(false);
    if (result.ok) setUrl(result.url);
    else setError(result.message);
  }

  async function copy(): Promise<void> {
    if (url === null) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError(
        'Não foi possível copiar automaticamente. Selecione o endereço e copie manualmente.',
      );
    }
  }

  return (
    <section className="card" aria-labelledby="feed-title">
      <h2 id="feed-title">Exportar ou assinar calendário</h2>
      <p className="muted small">
        Gere um endereço privado para assinar este calendário no Google Agenda, Apple Calendário ou
        Outlook. Gerar um novo endereço invalida o anterior.
      </p>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => void generate()}
          disabled={pending}
        >
          {pending
            ? 'Gerando…'
            : url === null
              ? 'Gerar endereço de assinatura'
              : 'Gerar novo endereço'}
        </button>
        {url !== null && (
          <a className="btn btn--ghost" href={url} download="calendario.ics">
            Baixar .ics
          </a>
        )}
      </div>
      {url !== null && (
        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="feed-url">Endereço de assinatura (mantenha em sigilo)</label>
          <div className="btn-row">
            <input
              id="feed-url"
              type="text"
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button type="button" className="btn" onClick={() => void copy()}>
              Copiar
            </button>
          </div>
        </div>
      )}
      <p role="status" aria-live="polite" className="small">
        {copied ? 'Endereço copiado.' : ''}
      </p>
      {error !== null && (
        <div className="alert alert--error" role="alert">
          <p>{error}</p>
        </div>
      )}
    </section>
  );
}
