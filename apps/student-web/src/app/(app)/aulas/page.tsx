import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState, ErrorState } from '@/components/States';
import { identity, lectures } from '@/lib/api';
import { formatClassDate, pluralize } from '@/lib/format';
import { guard } from '@/lib/http';
import { requireSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Aulas' };

const PAGE_SIZE = 12;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SORTS = { recent: 'Mais recentes', oldest: 'Mais antigas', course: 'Disciplina' } as const;
type Sort = keyof typeof SORTS;

type Params = {
  q?: string;
  curso?: string;
  de?: string;
  ate?: string;
  ordem?: string;
  pagina?: string;
};

function pageHref(params: Params, page: number): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (typeof v === 'string' && v !== '' && k !== 'pagina') sp.set(k, v);
  if (page > 1) sp.set('pagina', String(page));
  const s = sp.toString();
  return s === '' ? '/aulas' : `/aulas?${s}`;
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}): Promise<React.JSX.Element> {
  await requireSession();
  const params = await searchParams;
  const q = (params.q ?? '').trim().slice(0, 200);
  const from = DATE_RE.test(params.de ?? '') ? params.de : undefined;
  const to = DATE_RE.test(params.ate ?? '') ? params.ate : undefined;
  const sort: Sort = (params.ordem ?? '') in SORTS ? (params.ordem as Sort) : 'recent';
  const page = Math.max(1, Number.parseInt(params.pagina ?? '1', 10) || 1);
  const courseId = (params.curso ?? '').trim() || undefined;

  const sections = guard(await identity.sections());
  const result = sections.ok
    ? guard(
        await lectures.list({
          classSectionIds: sections.data,
          ...(q !== '' ? { q } : {}),
          ...(courseId !== undefined ? { courseId } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
          sort,
          page,
          pageSize: PAGE_SIZE,
        }),
      )
    : sections;

  const courses = result.ok
    ? Array.from(
        new Map(
          result.data.items
            .filter((i) => i.courseId !== undefined)
            .map((i) => [i.courseId ?? '', i.courseName ?? i.courseId ?? '']),
        ),
      )
    : [];
  const totalPages = result.ok ? Math.max(1, Math.ceil(result.data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Aulas</h1>
          <p>Resumos, tópicos e transcrições das aulas das suas turmas.</p>
        </div>
      </div>

      <form className="filters card" role="search" aria-label="Filtrar aulas" method="get">
        <div className="field">
          <label htmlFor="q">Buscar por título ou assunto</label>
          <input id="q" name="q" type="search" defaultValue={q} />
        </div>
        <div className="field">
          <label htmlFor="curso">Disciplina</label>
          <select id="curso" name="curso" defaultValue={courseId ?? ''}>
            <option value="">Todas</option>
            {courses.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="de">De</label>
          <input id="de" name="de" type="date" defaultValue={from ?? ''} />
        </div>
        <div className="field">
          <label htmlFor="ate">Até</label>
          <input id="ate" name="ate" type="date" defaultValue={to ?? ''} />
        </div>
        <div className="field">
          <label htmlFor="ordem">Ordenar por</label>
          <select id="ordem" name="ordem" defaultValue={sort}>
            {Object.entries(SORTS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="btn-row">
          <button type="submit" className="btn">
            Aplicar
          </button>
          <Link href="/aulas" className="btn btn--ghost">
            Limpar
          </Link>
        </div>
      </form>

      {!result.ok ? (
        <ErrorState message={result.message} />
      ) : result.data.items.length === 0 ? (
        <EmptyState title="Nenhuma aula encontrada">
          <p>Ajuste os filtros ou aguarde o processamento das aulas mais recentes.</p>
        </EmptyState>
      ) : (
        <>
          <p className="muted small" role="status">
            {pluralize(result.data.total, 'aula encontrada', 'aulas encontradas')}
          </p>
          <ul className="list-plain grid grid--2" style={{ gap: 16 }}>
            {result.data.items.map((lecture) => (
              <li
                key={lecture.scheduledClassId}
                className="card"
                style={{ border: '1px solid var(--border)', margin: 0 }}
              >
                <h2 style={{ fontSize: '1.05rem' }}>
                  <Link
                    href={`/aulas/${encodeURIComponent(lecture.scheduledClassId)}?secao=${encodeURIComponent(lecture.classSectionId)}`}
                  >
                    {lecture.title}
                  </Link>
                </h2>
                <p className="meta">
                  {lecture.courseName !== undefined && <span>{lecture.courseName}</span>}
                  <span>{formatClassDate(lecture.startsAt)}</span>
                  {lecture.topicCount !== undefined && (
                    <span>{pluralize(lecture.topicCount, 'tópico', 'tópicos')}</span>
                  )}
                </p>
                {lecture.executiveSummary !== undefined && (
                  <p className="small" style={{ marginBottom: 0 }}>
                    <span className="badge badge--ai" style={{ marginRight: 6 }}>
                      Gerado por IA
                    </span>
                    {lecture.executiveSummary.slice(0, 220)}
                    {lecture.executiveSummary.length > 220 ? '…' : ''}
                  </p>
                )}
              </li>
            ))}
          </ul>
          {totalPages > 1 && (
            <nav
              aria-label="Paginação"
              className="btn-row"
              style={{ marginTop: 16, justifyContent: 'center' }}
            >
              {page > 1 && (
                <Link className="btn btn--secondary" href={pageHref(params, page - 1)} rel="prev">
                  Anterior
                </Link>
              )}
              <span aria-current="page">
                Página {page} de {totalPages}
              </span>
              {page < totalPages && (
                <Link className="btn btn--secondary" href={pageHref(params, page + 1)} rel="next">
                  Próxima
                </Link>
              )}
            </nav>
          )}
        </>
      )}
    </>
  );
}
