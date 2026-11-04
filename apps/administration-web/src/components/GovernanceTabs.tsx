import Link from 'next/link';

const TABS = [
  { href: '/governanca', key: 'politicas', label: 'Políticas e consentimento' },
  { href: '/governanca/retencao', key: 'retencao', label: 'Retenção e retenções legais' },
  { href: '/governanca/titulares', key: 'titulares', label: 'Direitos dos titulares (LGPD)' },
] as const;

export function GovernanceTabs({
  current,
}: {
  current: (typeof TABS)[number]['key'];
}): React.JSX.Element {
  return (
    <nav aria-label="Seções de governança" className="tabs">
      <ul>
        {TABS.map((t) => (
          <li key={t.key}>
            <Link href={t.href} aria-current={t.key === current ? 'page' : undefined}>
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
