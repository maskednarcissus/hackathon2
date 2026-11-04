import Link from 'next/link';
import { SEVERITY_ICON, SEVERITY_TONE, severityLabel } from '../lib/labels';
import styles from './dashboard.module.css';

export const SUPPRESSED_HINT =
  'Valor ocultado: grupo com menos de 5 estudantes (regra de coorte mínima, LGPD).';

type Cohort = number | string | null | undefined | { suppressed: true };

export const isSuppressed = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && (v as { suppressed?: unknown }).suppressed === true;

/** Renders a cohort-protected metric; suppressed values show "—" with an explanation. */
export function CohortValue({
  value,
  suppressed = false,
  format = (n: number): string => n.toLocaleString('pt-BR'),
}: {
  value: Cohort;
  suppressed?: boolean;
  format?: (n: number) => string;
}): React.JSX.Element {
  if (suppressed || isSuppressed(value)) {
    return (
      <span title={SUPPRESSED_HINT} className="suppressed">
        <span aria-hidden="true">—</span>
        <span className="visually-hidden">{SUPPRESSED_HINT}</span>
      </span>
    );
  }
  if (value == null) return <span>—</span>;
  if (typeof value === 'number') return <span>{format(value)}</span>;
  return <span>{String(value)}</span>;
}

export function SeverityPill({ severity }: { severity: string }): React.JSX.Element {
  const tone = SEVERITY_TONE[severity] ?? 'muted';
  return (
    <span className={`${styles.pill} ${styles[`tone_${tone}`]}`}>
      <span aria-hidden="true" className={styles.pillIcon}>
        {SEVERITY_ICON[severity] ?? '?'}
      </span>
      {severityLabel(severity)}
    </span>
  );
}

export function Pill({
  icon,
  tone = 'muted',
  children,
}: {
  icon: string;
  tone?: 'success' | 'info' | 'warning' | 'danger' | 'muted';
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span className={`${styles.pill} ${styles[`tone_${tone}`]}`}>
      <span aria-hidden="true" className={styles.pillIcon}>
        {icon}
      </span>
      {children}
    </span>
  );
}

export function ServiceError({
  title,
  message,
  status,
}: {
  title: string;
  message: string;
  status?: number | undefined;
}): React.JSX.Element {
  return (
    <div role="alert" className="errorBox">
      <strong>{title}</strong>
      <p>{message}</p>
      {status === undefined ? (
        <p className="muted">
          O serviço pode estar fora do ar. Confira as URLs configuradas por variável de ambiente
          (ex.: <code>ACADEMIC_ANALYTICS_URL</code>, <code>NOTIFICATIONS_URL</code>).
        </p>
      ) : status === 401 || status === 403 ? (
        <p className="muted">
          Acesso negado. Verifique o token administrativo em <code>ADMIN_API_TOKEN</code>.
        </p>
      ) : null}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="emptyBox">{children}</p>;
}

export function Breadcrumb({
  trail,
}: {
  trail: { href?: string; label: string }[];
}): React.JSX.Element {
  return (
    <nav aria-label="Trilha" className="breadcrumb">
      <ol>
        {trail.map((t, i) => (
          <li key={`${t.label}-${i}`}>
            {t.href && i < trail.length - 1 ? (
              <Link href={t.href}>{t.label}</Link>
            ) : (
              <span aria-current={i === trail.length - 1 ? 'page' : undefined}>{t.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Tiles({
  items,
}: {
  items: {
    label: string;
    value: React.ReactNode;
    tone?: string | undefined;
    icon?: string | undefined;
  }[];
}): React.JSX.Element {
  return (
    <ul className={styles.tiles}>
      {items.map((t) => (
        <li
          key={t.label}
          className={`${styles.tile} ${t.tone ? (styles[`tone_${t.tone}`] ?? '') : ''}`}
        >
          <span className={styles.tileValue}>{t.value}</span>
          <span className={styles.tileLabel}>
            {t.icon ? <span aria-hidden="true">{t.icon} </span> : null}
            {t.label}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  hrefFor,
}: {
  page: number;
  pageSize: number;
  total: number;
  hrefFor: (page: number) => string;
}): React.JSX.Element | null {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  if (pages <= 1) return null;
  return (
    <nav aria-label="Paginação" className="pagination">
      {page > 1 ? (
        <Link href={hrefFor(page - 1)}>← Anterior</Link>
      ) : (
        <span aria-hidden="true">← Anterior</span>
      )}
      <span>
        Página {page} de {pages}
      </span>
      {page < pages ? (
        <Link href={hrefFor(page + 1)}>Próxima →</Link>
      ) : (
        <span aria-hidden="true">Próxima →</span>
      )}
    </nav>
  );
}

/** Horizontal ratio bar with the value always printed as text (never color/length only). */
export function RatioBar({
  value,
  label,
}: {
  value: number | null | undefined;
  label: string;
}): React.JSX.Element {
  const pct = value == null || !Number.isFinite(value) ? null : Math.max(0, Math.min(1, value));
  return (
    <span>
      <span
        className="barTrack"
        role="img"
        aria-label={`${label}: ${pct == null ? 'sem dados' : `${Math.round(pct * 100)}%`}`}
      >
        <span className="barFill" style={{ width: `${pct == null ? 0 : pct * 100}%` }} />
      </span>{' '}
      {pct == null ? '—' : `${Math.round(pct * 100)}%`}
    </span>
  );
}
