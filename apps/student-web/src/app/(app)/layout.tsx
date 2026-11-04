import Link from 'next/link';
import { logoutAction } from '@/app/actions';
import { Icon } from '@/components/Icon';
import { NavLinks } from '@/components/NavLinks';
import { notifications } from '@/lib/api';
import { requireSession } from '@/lib/session';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const session = await requireSession();
  const unread = await notifications.list(session.userId, true);
  const unreadCount = unread.ok ? unread.data.filter((n) => !n.readAt).length : 0;

  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link href="/" className="brand">
            Classroom Intelligence
          </Link>
          <NavLinks variant="top" />
          <div className="header-actions">
            <Link
              href="/notificacoes"
              className="icon-link"
              aria-label={
                unreadCount > 0 ? `Notificações, ${unreadCount} não lidas` : 'Notificações'
              }
            >
              <Icon name="bell" />
              {unreadCount > 0 && (
                <span className="count-badge" aria-hidden="true">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </Link>
            <Link href="/preferencias" className="icon-link" aria-label="Preferências">
              <Icon name="settings" />
            </Link>
            <form action={logoutAction}>
              <button type="submit" className="icon-link icon-btn" aria-label="Sair">
                <Icon name="logout" />
              </button>
            </form>
          </div>
        </div>
      </header>
      <main id="conteudo" tabIndex={-1}>
        {children}
      </main>
      <NavLinks variant="bottom" />
    </>
  );
}
