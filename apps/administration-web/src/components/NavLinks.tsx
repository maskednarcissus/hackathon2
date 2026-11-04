'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Visão geral' },
  { href: '/coordenacao', label: 'Coordenação' },
  { href: '/calendario-avaliacoes', label: 'Calendário de avaliações' },
  { href: '/devices', label: 'Dispositivos' },
  { href: '/incidentes', label: 'Incidentes' },
  { href: '/relatorios', label: 'Relatórios' },
  { href: '/governanca', label: 'Governança' },
];

export function NavLinks(): React.JSX.Element {
  const pathname = usePathname();
  return (
    <ul>
      {LINKS.map((l) => {
        const active = l.href === '/' ? pathname === '/' : pathname.startsWith(l.href);
        return (
          <li key={l.href}>
            <Link href={l.href} aria-current={active ? 'page' : undefined}>
              {l.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
