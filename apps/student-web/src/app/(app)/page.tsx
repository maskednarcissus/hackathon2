import Link from 'next/link';
import { EmptyState, ErrorState } from '@/components/States';
import { EventItem } from '@/components/EventItem';
import { calendar, identity, lectures, notifications } from '@/lib/api';
import { addDays, todayIn } from '@/lib/calendar-grid';
import { DEFAULT_TIMEZONE } from '@/lib/config';
import { ASSESSMENT_TYPES, formatClassDate, formatDateTime } from '@/lib/format';
import { guard } from '@/lib/http';
import { requireSession } from '@/lib/session';

export default async function HomePage(): Promise<React.JSX.Element> {
  const session = await requireSession();
  const today = todayIn(DEFAULT_TIMEZONE);
  const sections = guard(await identity.sections());
  const [events, recent, notes] = await Promise.all([
    calendar.studentEvents(session.studentId, today, addDays(today, 21)),
    sections.ok
      ? lectures.list({ classSectionIds: sections.data, sort: 'recent', pageSize: 5 })
      : Promise.resolve(sections),
    notifications.list(session.userId),
  ]);
  guard(events);

  const upcoming = events.ok
    ? events.data
        .filter((e) => e.eventDate !== null && e.eventDate >= today)
        .sort((a, b) => (a.eventDate ?? '').localeCompare(b.eventDate ?? ''))
    : [];
  const assessments = upcoming.filter((e) => ASSESSMENT_TYPES.has(e.type)).slice(0, 6);
  const classChanges = upcoming.filter((e) => !ASSESSMENT_TYPES.has(e.type)).slice(0, 4);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Olá!</h1>
          <p>Seu resumo acadêmico das próximas semanas.</p>
        </div>
        <Link href="/assistente" className="btn btn--secondary">
          Perguntar ao assistente
        </Link>
      </div>

      <div className="grid grid--2">
        <section className="card" aria-labelledby="upcoming-title">
          <h2 id="upcoming-title">Próximas avaliações e prazos</h2>
          {!events.ok ? (
            <ErrorState message={events.message} />
          ) : assessments.length === 0 ? (
            <p className="muted">Nenhuma avaliação ou prazo nas próximas três semanas.</p>
          ) : (
            <ul className="list-plain">
              {assessments.map((e) => (
                <li key={e.id}>
                  <EventItem event={e} />
                </li>
              ))}
            </ul>
          )}
          <p className="small" style={{ marginTop: 12, marginBottom: 0 }}>
            <Link href="/calendario?view=agenda">Ver calendário completo</Link>
          </p>
        </section>

        <section className="card" aria-labelledby="changes-title">
          <h2 id="changes-title">Mudanças nas aulas</h2>
          {!events.ok ? (
            <ErrorState message={events.message} />
          ) : classChanges.length === 0 ? (
            <p className="muted">Nenhum cancelamento, remarcação ou troca de sala prevista.</p>
          ) : (
            <ul className="list-plain">
              {classChanges.map((e) => (
                <li key={e.id}>
                  <EventItem event={e} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="recent-title" style={{ marginTop: 16 }}>
        <h2 id="recent-title">Aulas recentes</h2>
        {!recent.ok ? (
          <ErrorState message={recent.message} />
        ) : recent.data.items.length === 0 ? (
          <EmptyState title="Nenhuma aula processada ainda">
            <p>Os resumos aparecem aqui assim que as aulas gravadas forem processadas.</p>
          </EmptyState>
        ) : (
          <ul className="list-plain">
            {recent.data.items.map((lecture) => (
              <li key={lecture.scheduledClassId}>
                <Link
                  href={`/aulas/${encodeURIComponent(lecture.scheduledClassId)}`}
                  className="list-item"
                >
                  <span className="list-item__title">{lecture.title}</span>
                  <span className="meta">
                    {lecture.courseName !== undefined && <span>{lecture.courseName}</span>}
                    <span>{formatClassDate(lecture.startsAt)}</span>
                  </span>
                  {lecture.executiveSummary !== undefined && (
                    <span className="small muted" style={{ display: 'block', marginTop: 4 }}>
                      <span className="visually-hidden">Resumo gerado por IA: </span>
                      {lecture.executiveSummary.slice(0, 180)}
                      {lecture.executiveSummary.length > 180 ? '…' : ''}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
        <p className="small" style={{ marginTop: 12, marginBottom: 0 }}>
          <Link href="/aulas">Ver todas as aulas</Link>
        </p>
      </section>

      <section className="card" aria-labelledby="notes-title" style={{ marginTop: 16 }}>
        <h2 id="notes-title">Avisos recentes</h2>
        {!notes.ok ? (
          <ErrorState message={notes.message} />
        ) : notes.data.length === 0 ? (
          <p className="muted">Sem avisos por enquanto.</p>
        ) : (
          <ul className="list-plain">
            {notes.data.slice(0, 5).map((n) => (
              <li key={n.id} className="list-item">
                <strong>{n.title}</strong>
                {!n.readAt && (
                  <span className="badge badge--info" style={{ marginLeft: 8 }}>
                    Novo
                  </span>
                )}
                <p className="small" style={{ margin: '4px 0 0' }}>
                  {n.body}
                </p>
                <span className="meta">{formatDateTime(n.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
