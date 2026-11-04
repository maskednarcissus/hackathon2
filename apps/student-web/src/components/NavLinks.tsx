'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from './Icon';

const ITEMS: { href: string; label: string; icon: IconName }[] = [
  { href: '/', label: 'Início', icon: 'home' },
  { href: '/aulas', label: 'Aulas', icon: 'book' },
  { href: '/calendario', label: 'Calendário', icon: 'calendar' },
  { href: '/busca', label: 'Busca', icon: 'search' },
  { href: '/assistente', label: 'Assistente', icon: 'chat' },
];

function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

export function NavLinks({ variant }: { variant: 'top' | 'bottom' }): React.JSX.Element {
  const pathname = usePathname();
  return (
    <nav
      className={variant === 'top' ? 'top-nav' : 'bottom-nav'}
      aria-label={variant === 'top' ? 'Navegação principal' : 'Navegação principal (móvel)'}
    >
      <ul>
        {ITEMS.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={isActive(pathname, item.href) ? 'page' : undefined}
            >
              {variant === 'bottom' && <Icon name={item.icon} />}
              <span>{item.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
