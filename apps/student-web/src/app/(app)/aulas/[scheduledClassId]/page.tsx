import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EventItem } from '@/components/EventItem';
import { ReportButton } from '@/components/ReportButton';
import { AiBadge, Breadcrumb, ErrorState } from '@/components/States';
import { calendar, lectures } from '@/lib/api';
import { addDays, todayIn } from '@/lib/calendar-grid';
import { DEFAULT_TIMEZONE } from '@/lib/config';
import { eventSource, formatTimestamp, spokenTimestamp } from '@/lib/format';
import { guard } from '@/lib/http';
import { transcriptAtMs, transcriptAtSegment } from '@/lib/links';
import { requireSession } from '@/lib/session';
import type { LectureTopic } from '@/lib/types';

export const metadata: Metadata = { title: 'Aula' };

function revisionHref(
  classSectionId: string | null | undefined,
  conceptId?: string,
  term?: string,
): string {
  const sp = new URLSearchParams();
  if (classSectionId) sp.set('secao', classSectionId);
  if (conceptId !== undefined) sp.set('foco', conceptId);
  if (term !== undefined) sp.set('termo', term);
  const q = sp.toString();
  return q === '' ? '/revisao' : `/revisao?${q}#new-plan-title`;
}

const ASKED_BY = {
  student: 'Pergunta de estudante',
  professor: 'Pergunta do professor',
  unknown: 'Pergunta em aula',
};

function TopicList({
  topics,
  scheduledClassId,
}: {
  topics: LectureTopic[];
  scheduledClassId: string;
}): React.JSX.Element {
  return (
    <ol>
      {[...topics]
        .sort((a, b) => a.order - b.order)
        .map((topic) => (
          <li key={`${topic.order}-${topic.title}`} style={{ marginBottom: 8 }}>
            <strong>{topic.title}</strong>
            {topic.startMs !== undefined && (
              <>
                {' '}
                <Link
                  href={transcriptAtMs(scheduledClassId, topic.startMs, topic.segmentIndexes[0])}
                  className="small"
                  aria-label={`Ir para ${topic.title} na transcrição, em ${spokenTimestamp(topic.startMs)}`}
                >
                  {formatTimestamp(topic.startMs)}
                </Link>
              </>
            )}
            {topic.description !== undefined && (
              <p className="small muted" style={{ margin: 0 }}>
                {topic.description}
              </p>
            )}
            {topic.subtopics !== undefined && topic.subtopics.length > 0 && (
              <TopicList topics={topic.subtopics} scheduledClassId={scheduledClassId} />
            )}
          </li>
        ))}
    </ol>
  );
}

export default async function LecturePage({
  params,
  searchParams,
}: {
  params: Promise<{ scheduledClassId: string }>;
  searchParams: Promise<{ secao?: string }>;
}): Promise<React.JSX.Element> {
  const session = await requireSession();
  const { scheduledClassId } = await params;
  const { secao } = await searchParams;
  const result = guard(await lectures.get(scheduledClassId));
  if (!result.ok && (result.status === 404 || result.status === 403)) notFound();
  if (!result.ok) {
    return (
      <>
        <Breadcrumb items={[{ href: '/aulas', label: 'Aulas' }, { label: 'Aula' }]} />
        <h1>Aula</h1>
        <ErrorState message={result.message} />
      </>
    );
  }
  const lecture = result.data;
  const classSectionId = lecture.classSectionId ?? secao;

  const today = todayIn(DEFAULT_TIMEZONE);
  const events = await calendar.studentEvents(
    session.studentId,
    addDays(today, -180),
    addDays(today, 180),
  );
  const announcements = events.ok
    ? events.data.filter(
        (e) =>
          eventSource(e)?.transcriptId === lecture.transcriptId ||
          eventSource(e)?.scheduledClassId === scheduledClassId,
      )
    : [];

  return (
    <>
      <Breadcrumb items={[{ href: '/aulas', label: 'Aulas' }, { label: lecture.title }]} />
      <div className="page-header">
        <div>
          <h1>{lecture.title}</h1>
          <p>Material organizado automaticamente a partir da gravação da aula.</p>
        </div>
        <div className="btn-row">
          <Link href={`/aulas/${encodeURIComponent(scheduledClassId)}/transcricao`} className="btn">
            Ver transcrição
          </Link>
          <Link href={revisionHref(classSectionId)} className="btn btn--secondary">
            Revisar esta disciplina
          </Link>
          <Link
            href={`/assistente?aula=${encodeURIComponent(scheduledClassId)}`}
            className="btn btn--secondary"
          >
            Perguntar sobre esta aula
          </Link>
        </div>
      </div>

      <div className="layout-aside">
        <div>
          <section className="card ai-block" aria-labelledby="summary-title">
            <AiBadge />
            <h2 id="summary-title">Resumo</h2>
            <p>{lecture.executiveSummary}</p>
            <p className="small muted" style={{ marginBottom: 0 }}>
              Este resumo é uma síntese gerada por IA e não substitui a fala do professor. Confira
              os trechos na transcrição.
            </p>
            <ReportButton
              resourceType="lecture_summary"
              resourceId={lecture.lectureSummaryId}
              classSectionId={classSectionId}
              context="resumo da aula"
            />
          </section>

          {lecture.concepts.length > 0 && (
            <section className="card" aria-labelledby="concepts-title">
              <h2 id="concepts-title">Conceitos e definições</h2>
              <p className="small muted">
                <AiBadge /> Definições redigidas por IA com base no que foi dito em aula.
              </p>
              <dl>
                {lecture.concepts.map((concept, i) => (
                  <div key={`${concept.term}-${i}`} style={{ marginBottom: 12 }}>
                    <dt>
                      <strong>{concept.term}</strong>
                    </dt>
                    <dd style={{ margin: '4px 0 0' }}>
                      {concept.definition}
                      {concept.example !== undefined && (
                        <span className="small muted" style={{ display: 'block' }}>
                          Exemplo: {concept.example}
                        </span>
                      )}
                      <span className="btn-row small">
                        {concept.segmentIndexes[0] !== undefined && (
                          <Link
                            href={transcriptAtSegment(scheduledClassId, concept.segmentIndexes[0])}
                          >
                            Ver trecho da aula
                            <span className="visually-hidden"> sobre {concept.term}</span>
                          </Link>
                        )}
                        {concept.id !== undefined && (
                          <Link href={revisionHref(classSectionId, concept.id, concept.term)}>
                            Revisar este conceito
                            <span className="visually-hidden"> ({concept.term})</span>
                          </Link>
                        )}
                        <ReportButton
                          resourceType="concept"
                          resourceId={`${lecture.lectureSummaryId}:concept:${i}`}
                          classSectionId={classSectionId}
                          context={`definição de ${concept.term}`}
                        />
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {lecture.questions.length > 0 && (
            <section className="card" aria-labelledby="qa-title">
              <h2 id="qa-title">Perguntas e respostas da aula</h2>
              <ul className="list-plain">
                {lecture.questions.map((qa, i) => (
                  <li key={i} className="list-item">
                    <span className="small muted">{ASKED_BY[qa.askedBy]}</span>
                    <p style={{ margin: '2px 0' }}>
                      <strong>{qa.question}</strong>
                    </p>
                    {qa.answer !== undefined && (
                      <div className="ai-block small">
                        <AiBadge label="Resposta resumida por IA" />
                        <p style={{ margin: 0 }}>{qa.answer}</p>
                      </div>
                    )}
                    {qa.segmentIndexes[0] !== undefined && (
                      <Link
                        className="small"
                        href={transcriptAtSegment(scheduledClassId, qa.segmentIndexes[0])}
                      >
                        Ver no contexto da transcrição
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {lecture.readingReferences.length > 0 && (
            <section className="card" aria-labelledby="refs-title">
              <h2 id="refs-title">Leituras mencionadas</h2>
              <ul>
                {lecture.readingReferences.map((ref, i) => (
                  <li key={i}>
                    <cite>{ref.title}</cite>
                    {ref.authors !== undefined && <span className="muted"> — {ref.authors}</span>}
                    {ref.segmentIndexes[0] !== undefined && (
                      <>
                        {' '}
                        <Link
                          className="small"
                          href={transcriptAtSegment(scheduledClassId, ref.segmentIndexes[0])}
                        >
                          (onde foi citada)
                        </Link>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside aria-label="Estrutura e avisos da aula">
          <section className="card" aria-labelledby="outline-title">
            <h2 id="outline-title">Roteiro da aula</h2>
            {lecture.topics.length === 0 ? (
              <p className="muted">Sem tópicos identificados.</p>
            ) : (
              <TopicList topics={lecture.topics} scheduledClassId={scheduledClassId} />
            )}
          </section>
          <section className="card" aria-labelledby="ann-title">
            <h2 id="ann-title">Avisos desta aula</h2>
            {!events.ok ? (
              <ErrorState message={events.message} />
            ) : announcements.length === 0 ? (
              <p className="muted">Nenhuma avaliação, prazo ou mudança foi anunciada nesta aula.</p>
            ) : (
              <ul className="list-plain">
                {announcements.map((e) => (
                  <li key={e.id}>
                    <EventItem event={e} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
