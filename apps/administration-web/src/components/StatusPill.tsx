import { statusMeta } from '../lib/format';
import styles from './dashboard.module.css';

export function StatusPill({ status }: { status: string }): React.JSX.Element {
  const meta = statusMeta(status);
  return (
    <span className={`${styles.pill} ${styles[`tone_${meta.tone}`]}`}>
      <span aria-hidden="true" className={styles.pillIcon}>
        {meta.icon}
      </span>
      {meta.label}
    </span>
  );
}
