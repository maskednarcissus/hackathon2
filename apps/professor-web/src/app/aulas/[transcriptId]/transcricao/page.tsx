import Link from 'next/link';
import { SegmentEditor } from '@/components/SegmentEditor';
import { EmptyState, ErrorState } from '@/components/States';
import { ApiError, getAllSegments, getCorrections, getTranscript } from '@/lib/api';
import { confidenceLevel, formatDateTime, formatPercent, formatTimestamp } from '@/lib/format';
import type { Transcript, TranscriptCorrection, TranscriptSegment } from '@/lib/types';
import { correctSegmentAction } from './actions';

export const dynamic = 'force-dynamic';

/** Correction history is loaded for at most this many corrected segments per page view. */
const MAX_HISTORY_LOOKUPS = 50;

export default async function TranscriptPage({
  params,
  searchParams,
}: {
  params: Promise<{ transcriptId: string }>;
  searchParams: Promise<{ versao?: string }>;
}): Promise<React.JSX.Element> {
  const { transcriptId } = await params;
  const { versao } = await searchParams;
  const showOriginal = versao === 'original';

  let transcript: Transcript;
  let segments: TranscriptSegment[];
  try {
    [transcript, segments] = await Promise.all([
      getTranscript(transcriptId),
      getAllSegments(transcriptId),
    ]);
  } catch (err) {
    const notFound = err instanceof ApiError && err.status === 404;
    return (
      <ErrorState
        error={err}
        title={notFound ? 'Transcrição não encontrada' : 'Não foi possível carregar a transcrição'}
      />
    );
  }

  const corrected = segments.filter((s) => s.correctionStatus === 'corrected');
  const histories = new Map<number, TranscriptCorrection[]>();
  if (!showOriginal) {
    const results = await Promise.allSettled(
      corrected
        .slice(0, MAX_HISTORY_LOOKUPS)
        .map(
          async (s) =>
            [s.segmentIndex, await getCorrections(transcriptId, s.segmentIndex)] as const,
        ),
    );
    for (const r of results) if (r.status === 'fulfilled') histories.set(r.value[0], r.value[1]);
  }

  const base = `/aulas/${encodeURIComponent(transcriptId)}/transcricao`;
  const stats = transcript.stats;

  return (
    <>
      <h1>Transcrição da aula</h1>
      <p className="muted">
        Transcrição automática ({transcript.provider} · {transcript.model}) em {transcript.language}
        {stats
          ? ` · ${stats.segmentCount} segmentos · duração ${formatTimestamp(stats.durationMs)}`
          : ''}
        {stats?.averageConfidence != null
          ? ` · confiança média ${formatPercent(stats.averageConfidence)}`
          : ''}
        . Rótulos de locutor (LOCUTOR 1, 2…) são anônimos e não identificam pessoas.
      </p>

      <nav aria-label="Versão da transcrição">
        <ul className="filters">
          <li>
            <Link href={base} aria-current={!showOriginal ? 'page' : undefined}>
              Versão corrigida ({corrected.length} correções)
            </Link>
          </li>
          <li>
            <Link href={`${base}?versao=original`} aria-current={showOriginal ? 'page' : undefined}>
              Original da máquina
            </Link>
          </li>
        </ul>
      </nav>

      {segments.length === 0 ? (
        <EmptyState title="Transcrição vazia">
          <p className="muted">Nenhum segmento foi transcrito para esta gravação.</p>
        </EmptyState>
      ) : (
        <ol aria-label="Segmentos" style={{ listStyle: 'none', padding: 0 }} className="card">
          {segments.map((s) => {
            const isCorrected = s.correctionStatus === 'corrected';
            const text = showOriginal ? (s.originalText ?? s.text) : s.text;
            const history = histories.get(s.segmentIndex) ?? [];
            const level = confidenceLevel(s.confidence);
            return (
              <li
                key={s.segmentIndex}
                id={`seg-${s.segmentIndex}`}
                className="segment"
                tabIndex={-1}
              >
                <div className="segment-meta">
                  <div>{formatTimestamp(s.startMs)}</div>
                  {s.speakerLabel ? (
                    <div>{s.speakerLabel.replace('SPEAKER_', 'LOCUTOR ')}</div>
                  ) : null}
                  <div title="Confiança da transcrição">
                    {formatPercent(s.confidence)} ({level})
                  </div>
                </div>
                <div>
                  <p className="segment-text" lang={s.language}>
                    {text}
                  </p>
                  {isCorrected && !showOriginal ? (
                    <p className="muted">
                      <span className="tag">Corrigido</span>
                      {s.originalText ? <>Original: “{s.originalText}”</> : null}
                    </p>
                  ) : null}
                  {history.length > 0 ? (
                    <details>
                      <summary>Histórico de correções ({history.length})</summary>
                      <ol>
                        {history.map((c) => (
                          <li key={c.version}>
                            v{c.version} · {formatDateTime(c.correctedAt)} — “{c.correctedText}”
                            {c.reason ? <span className="muted"> ({c.reason})</span> : null}
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : null}
                  {!showOriginal ? (
                    <SegmentEditor
                      segmentIndex={s.segmentIndex}
                      text={s.text}
                      action={correctSegmentAction.bind(null, transcriptId, s.segmentIndex, s.text)}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
