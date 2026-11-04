import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RevisionItemCard } from '@/components/RevisionItemCard';
import { RevisionNotice } from '@/components/RevisionNotice';
import { Breadcrumb, EmptyState, ErrorState } from '@/components/States';
import { revision } from '@/lib/api';
import { formatDateShort, formatDateTime } from '@/lib/format';
import { guard } from '@/lib/http';
import { KIND_LABELS, KIND_ORDER } from '@/lib/revision';
import { requireSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Plano de revisão' };

export default async function RevisionPlanPage({
  params,
}: {
  params: Promise<{ planId: string }>;
}): Promise<React.JSX.Element> {
  const session = await requireSession();
  const { planId } = await params;
  const result = guard(await revision.getPlan(planId, session.studentId));
  if (!result.ok && (result.status === 404 || result.status === 403)) notFound();
  const crumbs = [{ href: '/revisao', label: 'Revisão' }, { label: 'Plano' }];
  if (!result.ok) {
    return (
      <>
        <Breadcrumb items={crumbs} />
        <h1>Plano de revisão</h1>
        <ErrorState message={result.message} />
      </>
    );
  }
  const plan = result.data;
  const groups = KIND_ORDER.map((kind) => ({
    kind,
    items: plan.items.filter((i) => i.kind === kind),
  })).filter((g) => g.items.length > 0);
  const period =
    plan.from !== null || plan.to !== null
      ? `Aulas ${plan.from !== null ? `de ${formatDateShort(plan.from)}` : ''} ${plan.to !== null ? `até ${formatDateShort(plan.to)}` : ''}`.trim()
      : 'Todas as aulas processadas';

  return (
    <>
      <Breadcrumb items={crumbs} />
      <div className="page-header">
        <div>
          <h1>Plano de revisão</h1>
          <p>
            Gerado em {formatDateTime(plan.generatedAt)} · {period} · {plan.items.length} item(ns)
          </p>
        </div>
        <Link href="/revisao" className="btn btn--secondary">
          Ver o que revisar hoje
        </Link>
      </div>

      <div className="layout-aside">
        <div>
          {groups.length === 0 ? (
            <EmptyState title="Nenhum material gerado">
              <p>Veja as limitações ao lado e tente outro período ou disciplina.</p>
            </EmptyState>
          ) : (
            <>
              <nav aria-label="Seções do plano" className="btn-row" style={{ marginBottom: 12 }}>
                {groups.map((g) => (
                  <a key={g.kind} href={`#${g.kind}`} className="btn btn--ghost btn--small">
                    {KIND_LABELS[g.kind]} ({g.items.length})
                  </a>
                ))}
              </nav>
              {groups.map((g) => (
                <section
                  key={g.kind}
                  id={g.kind}
                  aria-labelledby={`${g.kind}-title`}
                  style={{ marginBottom: 24 }}
                >
                  <h2 id={`${g.kind}-title`}>{KIND_LABELS[g.kind]}</h2>
                  <div className="stack">
                    {g.items.map((item) => (
                      <RevisionItemCard key={item.id} item={item} />
                    ))}
                  </div>
                </section>
              ))}
            </>
          )}
        </div>
        <aside>
          <RevisionNotice
            limitations={plan.limitations}
            dropped={plan.validation?.droppedItems ?? 0}
          />
        </aside>
      </div>
    </>
  );
}
