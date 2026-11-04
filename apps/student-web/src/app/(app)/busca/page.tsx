import type { Metadata } from 'next';
import Link from 'next/link';
import { Highlighted } from '@/components/Highlighted';
import { EmptyState, ErrorState } from '@/components/States';
import { identity, transcripts } from '@/lib/api';
import { formatTimestamp, pluralize, speakerName } from '@/lib/format';
import { guard } from '@/lib/http';
import { transcriptAtMs } from '@/lib/links';
import { requireSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Busca' };

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}): Promise<React.JSX.Element> {
  await requireSession();
  const q = ((await searchParams).q ?? '').trim().slice(0, 300);

  let body: React.JSX.Element | null = null;
  if (q.length >= 2) {
    const sections = guard(await identity.sections());
    const result = sections.ok ? guard(await transcripts.search(q, sections.data, 30)) : sections;
    if (!result.ok) {
      body = <ErrorState message={result.message} />;
    } else if (result.data.length === 0) {
      body = (
        <EmptyState title="Nada encontrado">
          <p>Tente outras palavras ou termos mais gerais.</p>
        </EmptyState>
      );
    } else {
      body = (
        <>
          <p role="status" className="muted small">
            {pluralize(result.data.length, 'trecho encontrado', 'trechos encontrados')} para “{q}”
          </p>
          <ol className="list-plain card">
            {result.data.map((r) => {
              const speaker = speakerName(r.speakerLabel);
              return (
                <li key={`${r.transcriptId}-${r.segmentIndex}`}>
                  <Link
                    href={transcriptAtMs(r.scheduledClassId, r.startMs, r.segmentIndex)}
                    className="list-item"
                  >
                    <span className="meta">
                      <span>Aula · {formatTimestamp(r.startMs)}</span>
                      {speaker !== null && <span>{speaker}</span>}
                    </span>
                    <span style={{ display: 'block', color: 'var(--text)' }}>
                      <Highlighted text={r.text} query={q} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </>
      );
    }
  } else if (q.length > 0) {
    body = <p className="muted">Digite pelo menos 2 caracteres.</p>;
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Busca nas aulas</h1>
          <p>Encontre o momento exato em que um assunto foi tratado nas suas aulas.</p>
        </div>
      </div>
      <form role="search" className="search-form" method="get" aria-label="Buscar nas transcrições">
        <label htmlFor="busca-q" className="visually-hidden">
          Termo de busca
        </label>
        <input
          id="busca-q"
          name="q"
          type="search"
          defaultValue={q}
          placeholder="Ex.: curva IS-LM, habeas corpus…"
        />
        <button type="submit" className="btn">
          Buscar
        </button>
      </form>
      {body}
    </>
  );
}
