import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Icon } from '@/components/Icon';
import { DelegatedReportDialog } from '@/components/ReportButton';
import { Breadcrumb, EmptyState, ErrorState } from '@/components/States';
import { TranscriptFocus } from '@/components/TranscriptFocus';
import { lectures, transcripts } from '@/lib/api';
import { formatTimestamp, speakerName, spokenTimestamp } from '@/lib/format';
import { guard } from '@/lib/http';
import { transcriptAtMs } from '@/lib/links';
import { requireSession } from '@/lib/session';
import type { LectureTopic, TranscriptSegment } from '@/lib/types';

export const metadata: Metadata = { title: 'Transcrição' };

/** Flattens topics and maps each to the segment where it starts. */
function topicStarts(
  topics: LectureTopic[],
  segments: TranscriptSegment[],
): Map<number, LectureTopic[]> {
  const flat: LectureTopic[] = [];
  const walk = (list: LectureTopic[]): void =>
    list.forEach((t) => {
      flat.push(t);
      if (t.subtopics) walk(t.subtopics);
    });
  walk(topics);
  const map = new Map<number, LectureTopic[]>();
  for (const topic of flat) {
    let index = topic.segmentIndexes.length > 0 ? Math.min(...topic.segmentIndexes) : undefined;
    if (index === undefined && topic.startMs !== undefined) {
      index = segments.find((s) => s.endMs > (topic.startMs ?? 0))?.segmentIndex;
    }
    if (index === undefined) continue;
    map.set(index, [...(map.get(index) ?? []), topic]);
  }
  return map;
}

export default async function TranscriptPage({
  params,
  searchParams,
}: {
  params: Promise<{ scheduledClassId: string }>;
  searchParams: Promise<{ t?: string; s?: string; secao?: string }>;
}): Promise<React.JSX.Element> {
  await requireSession();
  const { scheduledClassId } = await params;
  const sp = await searchParams;
  const targetMs = sp.t !== undefined && /^\d+$/.test(sp.t) ? Number(sp.t) : null;
  const targetIndex = sp.s !== undefined && /^\d+$/.test(sp.s) ? Number(sp.s) : null;

  const lecture = guard(await lectures.get(scheduledClassId));
  if (!lecture.ok && (lecture.status === 404 || lecture.status === 403)) notFound();
  const crumbs = [
    { href: '/aulas', label: 'Aulas' },
    {
      href: `/aulas/${encodeURIComponent(scheduledClassId)}`,
      label: lecture.ok ? lecture.data.title : 'Aula',
    },
    { label: 'Transcrição' },
  ];
  if (!lecture.ok) {
    return (
      <>
        <Breadcrumb items={crumbs} />
        <h1>Transcrição</h1>
        <ErrorState message={lecture.message} />
      </>
    );
  }
  const segments = guard(await transcripts.segments(lecture.data.transcriptId));
  const classSectionId = (lecture.data as { classSectionId?: string }).classSectionId ?? sp.secao;
  const markers = segments.ok
    ? topicStarts(lecture.data.topics, segments.data)
    : new Map<number, LectureTopic[]>();
  const corrected = segments.ok
    ? segments.data.filter((s) => s.correctionStatus === 'corrected').length
    : 0;

  return (
    <>
      <Breadcrumb items={crumbs} />
      <div className="page-header">
        <div>
          <h1>Transcrição: {lecture.data.title}</h1>
          <p>
            Transcrição automática da gravação. Pessoas são identificadas apenas como “Pessoa 1”,
            “Pessoa 2”… {corrected > 0 && `${corrected} trecho(s) revisado(s) pelo professor.`}
          </p>
        </div>
      </div>

      {!segments.ok ? (
        <ErrorState message={segments.message} />
      ) : segments.data.length === 0 ? (
        <EmptyState title="Transcrição indisponível">
          <p>A transcrição desta aula ainda está sendo processada.</p>
        </EmptyState>
      ) : (
        <div className="layout-aside">
          <ol className="transcript card" aria-label="Trechos da transcrição">
            {segments.data.map((segment) => {
              const topics = markers.get(segment.segmentIndex) ?? [];
              const speaker = speakerName(segment.speakerLabel);
              const time = formatTimestamp(segment.startMs);
              return [
                ...topics.map((topic) => (
                  <li
                    key={`topic-${topic.order}-${topic.title}`}
                    className="topic-marker"
                    id={`topico-${topic.order}`}
                  >
                    <span className="visually-hidden">Tópico: </span>
                    {topic.title}
                  </li>
                )),
                <li
                  key={segment.segmentIndex}
                  id={`s-${segment.segmentIndex}`}
                  className="segment"
                  tabIndex={-1}
                  data-start={segment.startMs}
                  data-end={segment.endMs}
                >
                  <Link
                    href={transcriptAtMs(scheduledClassId, segment.startMs, segment.segmentIndex)}
                    className="segment__time"
                    aria-label={`Link para ${spokenTimestamp(segment.startMs)}`}
                  >
                    {time}
                  </Link>
                  <div>
                    {speaker !== null && <div className="segment__speaker">{speaker}</div>}
                    <p style={{ margin: 0 }}>
                      {segment.text}
                      {segment.correctionStatus === 'corrected' && (
                        <span className="badge badge--success" style={{ marginLeft: 8 }}>
                          Revisado
                        </span>
                      )}
                      {segment.confidence < 0.6 && (
                        <span className="badge badge--warning" style={{ marginLeft: 8 }}>
                          Baixa confiança
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="segment__actions">
                    <button
                      type="button"
                      className="btn btn--ghost btn--small"
                      data-report-id={`${lecture.data.transcriptId}:${segment.segmentIndex}`}
                      data-report-context={`trecho em ${time}`}
                      aria-label={`Reportar erro no trecho em ${time}`}
                    >
                      <Icon name="flag" />
                      <span aria-hidden="true">Reportar</span>
                    </button>
                  </div>
                </li>,
              ];
            })}
          </ol>
          {lecture.data.topics.length > 0 && (
            <nav className="card toc" aria-label="Tópicos da aula">
              <h2>Tópicos</h2>
              <ol>
                {[...lecture.data.topics]
                  .sort((a, b) => a.order - b.order)
                  .map((topic) => (
                    <li key={`${topic.order}-${topic.title}`}>
                      <a href={`#topico-${topic.order}`}>{topic.title}</a>
                      {topic.startMs !== undefined && (
                        <span className="small muted"> · {formatTimestamp(topic.startMs)}</span>
                      )}
                    </li>
                  ))}
              </ol>
            </nav>
          )}
          <TranscriptFocus targetMs={targetMs} targetIndex={targetIndex} />
          <DelegatedReportDialog
            resourceType="transcript_segment"
            classSectionId={classSectionId}
          />
        </div>
      )}
    </>
  );
}
