import type { StatusTone } from '@/lib/format';

export function ErrorState({
  title = 'Não foi possível carregar',
  message,
}: {
  title?: string;
  message: string;
}): React.JSX.Element {
  return (
    <div className="alert alert--error" role="alert">
      <p>
        <strong>{title}.</strong> {message}
      </p>
    </div>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="state">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function StatusBadge({
  label,
  tone,
}: {
  label: string;
  tone: StatusTone;
}): React.JSX.Element {
  return <span className={`badge badge--${tone}`}>{label}</span>;
}

/** Marks AI-generated content — required on every generated block (GENERAL.md AI principles). */
export function AiBadge({ label = 'Gerado por IA' }: { label?: string }): React.JSX.Element {
  return (
    <span className="badge badge--ai">
      <span aria-hidden="true">✦</span> {label}
    </span>
  );
}

export function Breadcrumb({
  items,
}: {
  items: { href?: string; label: string }[];
}): React.JSX.Element {
  return (
    <nav className="breadcrumb" aria-label="Você está em">
      <ol>
        {items.map((item, i) => (
          <li key={`${item.label}-${i}`}>
            {item.href !== undefined && i < items.length - 1 ? (
              <a href={item.href}>{item.label}</a>
            ) : (
              <span aria-current={i === items.length - 1 ? 'page' : undefined}>{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
