import type { Metadata } from 'next';
import Link from 'next/link';
import { markAllNotificationsReadAction, markNotificationReadAction } from '@/app/actions';
import { EmptyState, ErrorState } from '@/components/States';
import { notifications } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { guard } from '@/lib/http';
import { requireSession } from '@/lib/session';

export const metadata: Metadata = { title: 'Notificações' };

const CATEGORY_LABELS: Record<string, string> = {
  new_assessment: 'Nova avaliação',
  deadline_change: 'Prazo alterado',
  class_cancellation: 'Aula cancelada',
  lecture_summary: 'Resumo disponível',
  reminder: 'Lembrete',
};

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ filtro?: string }>;
}): Promise<React.JSX.Element> {
  const session = await requireSession();
  const unreadOnly = (await searchParams).filtro === 'nao-lidas';
  const result = guard(await notifications.list(session.userId, unreadOnly));
  const list = result.ok
    ? [...result.data].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : [];
  const unread = list.filter((n) => !n.readAt).length;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Notificações</h1>
          <p>{unread > 0 ? `${unread} não lida(s).` : 'Tudo em dia.'}</p>
        </div>
        <div className="btn-row">
          <nav className="view-switch" aria-label="Filtrar notificações">
            <Link href="/notificacoes" aria-current={!unreadOnly ? 'page' : undefined}>
              Todas
            </Link>
            <Link
              href="/notificacoes?filtro=nao-lidas"
              aria-current={unreadOnly ? 'page' : undefined}
            >
              Não lidas
            </Link>
          </nav>
          {unread > 0 && (
            <form action={markAllNotificationsReadAction}>
              <button type="submit" className="btn btn--secondary">
                Marcar todas como lidas
              </button>
            </form>
          )}
        </div>
      </div>

      {!result.ok ? (
        <ErrorState message={result.message} />
      ) : list.length === 0 ? (
        <EmptyState title={unreadOnly ? 'Nenhuma notificação não lida' : 'Nenhuma notificação'} />
      ) : (
        <ul className="list-plain card">
          {list.map((n) => (
            <li key={n.id} className="list-item">
              <div className="btn-row" style={{ justifyContent: 'space-between' }}>
                <span className="meta">
                  <span>{CATEGORY_LABELS[n.category] ?? 'Aviso'}</span>
                  <span>{formatDateTime(n.createdAt)}</span>
                  {!n.readAt && <span className="badge badge--info">Não lida</span>}
                </span>
                {!n.readAt && (
                  <form action={markNotificationReadAction}>
                    <input type="hidden" name="id" value={n.id} />
                    <button type="submit" className="btn btn--ghost btn--small">
                      Marcar como lida<span className="visually-hidden">: {n.title}</span>
                    </button>
                  </form>
                )}
              </div>
              <p style={{ margin: '4px 0 0' }}>
                {n.link !== undefined && n.link.startsWith('/') ? (
                  <Link href={n.link}>
                    <strong>{n.title}</strong>
                  </Link>
                ) : (
                  <strong>{n.title}</strong>
                )}
              </p>
              <p className="small" style={{ margin: 0 }}>
                {n.body}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="small" style={{ marginTop: 16 }}>
        <Link href="/preferencias">Escolher como receber notificações</Link>
      </p>
    </>
  );
}
