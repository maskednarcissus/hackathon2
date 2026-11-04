import { CONFIDENCE_LABELS, confidenceLevel, formatPercent } from '@/lib/format';
import type { ExtractionConfidence } from '@/lib/types';

const ORDER: (keyof ExtractionConfidence)[] = [
  'overall',
  'transcription',
  'eventClassification',
  'dateInterpretation',
  'courseAssociation',
];

export function ConfidenceBreakdown({
  confidence,
  compact = false,
}: {
  confidence: ExtractionConfidence;
  compact?: boolean;
}): React.JSX.Element {
  const keys = compact ? (['overall', 'dateInterpretation'] as const) : ORDER;
  return (
    <dl className="confidence">
      {keys.map((key) => {
        const value = confidence[key];
        const level = confidenceLevel(value);
        const id = `conf-${key}`;
        return (
          <div key={key} className="confidence-row" data-level={level}>
            <dt id={id}>{CONFIDENCE_LABELS[key]}</dt>
            <dd>
              <meter
                aria-labelledby={id}
                min={0}
                max={1}
                low={0.7}
                high={0.92}
                optimum={1}
                value={value}
              />
              <span className="confidence-text">
                {formatPercent(value)} <span className="muted">({level})</span>
              </span>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
