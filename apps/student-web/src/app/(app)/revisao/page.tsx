import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { RevisionItemCard } from '@/components/RevisionItemCard';
import { RevisionNotice } from '@/components/RevisionNotice';
import { RevisionPlanForm, type SectionOption } from '@/components/RevisionPlanForm';
import { ErrorState } from '@/components/States';
import { identity, lectures, revision } from '@/lib/api';
import { formatDateShort } from '@/lib/format';
import { guard } from '@/lib/http';
import { requireSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Revisão' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const asArray = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

export default async function RevisionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const session = await requireSession();
  const sp = await searchParams;
  const sections = guard(await identity.sections());
  const [due, catalog] = await Promise.all([
    revision.due(session.studentId),
    sections.ok
      ? lectures.list({ classSectionIds: sections.data, pageSize: 100, sort: 'course' })
      : Promise.resolve(sections),
  ]);
  guard(due);

  const names = new Map<string, string>();
  if (catalog.ok) {
    for (const item of catalog.data.items) {
      if (item.courseName) names.set(item.classSectionId, item.courseName);
    }
  }
  const sectionOptions: SectionOption[] = sections.ok
    ? sections.data.map((id, i) => ({ id, label: names.get(id) ?? `Disciplina ${i + 1}` }))
    : [];
  const focusIds = asArray(sp['foco']).filter((v) => UUID_RE.test(v));
  const focusTerms = asArray(sp['termo']);
  const focus = focusIds.map((id, i) => ({
    id,
    term: (focusTerms[i] ?? 'Conceito').slice(0, 120),
  }));
  const selectedSections = asArray(sp['secao']).filter((v) => UUID_RE.test(v));
  const from = DATE_RE.test(String(sp['de'] ?? '')) ? String(sp['de']) : '';
  const to = DATE_RE.test(String(sp['ate'] ?? '')) ? String(sp['ate']) : '';

  const recent = ((await cookies()).get('ci_rev')?.value ?? '')
    .split(',')
    .map((entry) => entry.split('~'))
    .filter(
      (parts): parts is [string, string, string] =>
        parts.length === 3 && UUID_RE.test(parts[0] ?? ''),
    );

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Revisão</h1>
          <p>Material de estudo personalizado a partir das suas aulas, com repetição espaçada.</p>
        </div>
      </div>

      <div className="layout-aside">
        <div className="stack">
          <section aria-labelledby="due-title">
            <h2 id="due-title">Para revisar hoje</h2>
            {!due.ok ? (
              <ErrorState message={due.message} />
            ) : due.data.items.length === 0 ? (
              <div className="card">
                <p style={{ margin: 0 }}>
                  Nada pendente hoje.{' '}
                  {recent.length === 0 && 'Gere um plano de revisão para começar.'}
                </p>
              </div>
            ) : (
              <>
                <p className="small muted" role="status">
                  {due.data.total} item(ns) para revisar
                  {due.data.total > due.data.items.length &&
                    ` (mostrando ${due.data.items.length})`}
                  .
                </p>
                <div className="stack">
                  {due.data.items.map((item) => (
                    <RevisionItemCard key={item.id} item={item} />
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="card" aria-labelledby="new-plan-title">
            <h2 id="new-plan-title">Criar plano de revisão</h2>
            {!sections.ok ? (
              <ErrorState message={sections.message} />
            ) : (
              <RevisionPlanForm
                sections={sectionOptions}
                selectedSections={selectedSections}
                focus={focus}
                from={from}
                to={to}
              />
            )}
          </section>
        </div>

        <aside className="stack" aria-label="Planos e limitações">
          {recent.length > 0 && (
            <section className="card" aria-labelledby="recent-plans-title">
              <h2 id="recent-plans-title">Seus planos recentes</h2>
              <ul className="list-plain">
                {recent.map(([id, date, count]) => (
                  <li key={id}>
                    <Link className="list-item" href={`/revisao/${encodeURIComponent(id)}`}>
                      <span className="list-item__title">
                        Plano de {DATE_RE.test(date) ? formatDateShort(date) : date}
                      </span>
                      <span className="meta">{count} item(ns)</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <RevisionNotice />
        </aside>
      </div>
    </>
  );
}
