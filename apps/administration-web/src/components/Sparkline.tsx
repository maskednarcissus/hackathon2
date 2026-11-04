interface SparklineProps {
  values: (number | null | undefined)[];
  label: string;
  /** Formatted summary read by screen readers and shown beside the chart. */
  summary: string;
  width?: number;
  height?: number;
}

/** Minimal inline SVG sparkline; gaps (null) break the line. */
export function Sparkline({
  values,
  label,
  summary,
  width = 240,
  height = 48,
}: SparklineProps): React.JSX.Element {
  const points = values
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => typeof p.v === 'number' && Number.isFinite(p.v));
  if (points.length < 2) {
    return <p className="muted">{label}: dados insuficientes</p>;
  }
  const min = Math.min(...points.map((p) => p.v));
  const max = Math.max(...points.map((p) => p.v));
  const span = max - min || 1;
  const pad = 4;
  const x = (i: number): number => pad + (i / Math.max(values.length - 1, 1)) * (width - 2 * pad);
  const y = (v: number): number => height - pad - ((v - min) / span) * (height - 2 * pad);

  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      current.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    } else if (current.length) {
      segments.push(current.join(' '));
      current = [];
    }
  });
  if (current.length) segments.push(current.join(' '));
  const last = points[points.length - 1]!;

  return (
    <figure style={{ margin: 0 }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${label}: ${summary}`}
        viewBox={`0 0 ${width} ${height}`}
      >
        {segments.map((s) => (
          <polyline
            key={s}
            points={s}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2}
            strokeLinejoin="round"
          />
        ))}
        <circle cx={x(last.i)} cy={y(last.v)} r={3} fill="var(--accent)" />
      </svg>
      <figcaption className="muted">
        {label}: {summary}
      </figcaption>
    </figure>
  );
}
