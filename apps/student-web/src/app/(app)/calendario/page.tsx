import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarFeed } from '@/components/CalendarFeed';
import { EventItem } from '@/components/EventItem';
import { EmptyState, ErrorState } from '@/components/States';
import { calendar } from '@/lib/api';
import {
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  addDays,
  addMonths,
  monthGrid,
  todayIn,
  weekDays,
} from '@/lib/calendar-grid';
import { DEFAULT_TIMEZONE } from '@/lib/config';
import {
  EVENT_TYPE_LABELS,
  capitalizeFirst,
  eventStatus,
  formatDateLong,
  formatDateShort,
} from '@/lib/format';
import { guard } from '@/lib/http';
import { requireSession } from '@/lib/session';
import type { CalendarEvent } from '@/lib/types';

export const metadata: Metadata = { title: 'Calendário' };

type View = 'mes' | 'semana' | 'agenda';
const VIEWS: { key: View; label: string }[] = [
  { key: 'mes', label: 'Mês' },
  { key: 'semana', label: 'Semana' },
  { key: 'agenda', label: 'Agenda' },
];
const VIEW_ALIASES: Record<string, View> = {
  month: 'mes',
  week: 'semana',
  agenda: 'agenda',
  mes: 'mes',
  semana: 'semana',
};
const MONTH_FMT = new Intl.DateTimeFormat('pt-BR', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

function byDate(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    if (e.eventDate === null) continue;
    map.set(e.eventDate, [...(map.get(e.eventDate) ?? []), e]);
  }
  for (const list of map.values())
    list.sort((a, b) => (a.eventTime ?? '').localeCompare(b.eventTime ?? ''));
  return map;
}

function Chip({ event }: { event: CalendarEvent }): React.JSX.Element {
  const status = eventStatus(event);
  const label = `${EVENT_TYPE_LABELS[event.type] ?? 'Evento'}: ${event.title} (${status.label})`;
  return (
    <Link
      href={`/calendario/${encodeURIComponent(event.id)}`}
      className={`chip chip--${status.tone}`}
      title={label}
    >
      <span className="chip__text">
        {event.eventTime ? `${event.eventTime} ` : ''}
        {event.title}
        <span className="visually-hidden">
          {' '}
          — {EVENT_TYPE_LABELS[event.type]}, {status.label}
        </span>
      </span>
    </Link>
  );
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; data?: string }>;
}): Promise<React.JSX.Element> {
  const session = await requireSession();
  const sp = await searchParams;
  const view: View = VIEW_ALIASES[sp.view ?? ''] ?? 'mes';
  const today = todayIn(DEFAULT_TIMEZONE);
  const ref = /^\d{4}-\d{2}-\d{2}$/.test(sp.data ?? '') ? (sp.data as string) : today;
  const [year, month] = ref.split('-').map(Number) as [number, number];

  let from: string;
  let to: string;
  let prev: string;
  let next: string;
  let title: string;
  const grid = monthGrid(year, month, today);
  const week = weekDays(ref, today);
  if (view === 'mes') {
    from = grid[0]?.[0]?.date ?? ref;
    to = grid[grid.length - 1]?.[6]?.date ?? ref;
    const p = addMonths(year, month, -1);
    const n = addMonths(year, month, 1);
    prev = `${p.year}-${String(p.month).padStart(2, '0')}-01`;
    next = `${n.year}-${String(n.month).padStart(2, '0')}-01`;
    title = capitalizeFirst(MONTH_FMT.format(new Date(Date.UTC(year, month - 1, 1, 12))));
  } else if (view === 'semana') {
    from = week[0]?.date ?? ref;
    to = week[6]?.date ?? ref;
    prev = addDays(ref, -7);
    next = addDays(ref, 7);
    title = `Semana de ${formatDateShort(from)} a ${formatDateShort(to)}`;
  } else {
    from = ref;
    to = addDays(ref, 60);
    prev = addDays(ref, -60);
    next = addDays(ref, 60);
    title = `Próximos 60 dias a partir de ${formatDateShort(ref)}`;
  }

  const result = guard(await calendar.studentEvents(session.studentId, from, to));
  const events = result.ok ? result.data : [];
  const dated = byDate(events);
  const undated = events.filter((e) => e.eventDate === null);
  const href = (data: string, v: View = view): string => `/calendario?view=${v}&data=${data}`;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Calendário acadêmico</h1>
          <p>Avaliações, prazos e mudanças de aula das suas turmas, com a origem de cada aviso.</p>
        </div>
        <nav className="view-switch" aria-label="Modo de visualização">
          {VIEWS.map((v) => (
            <Link
              key={v.key}
              href={href(ref, v.key)}
              aria-current={v.key === view ? 'page' : undefined}
            >
              {v.label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="nav-row">
        <Link className="btn btn--secondary" href={href(prev)} aria-label="Período anterior">
          <span aria-hidden="true">‹</span>
          <span className="visually-hidden">Anterior</span>
        </Link>
        <h2 aria-live="polite">{title}</h2>
        <Link className="btn btn--secondary" href={href(next)} aria-label="Próximo período">
          <span aria-hidden="true">›</span>
          <span className="visually-hidden">Próximo</span>
        </Link>
      </div>
      <p style={{ textAlign: 'center', marginTop: -4 }}>
        <Link href={href(today)}>Ir para hoje</Link>
      </p>

      {!result.ok && <ErrorState message={result.message} />}

      {view === 'mes' && (
        <div className="card" style={{ padding: 8, overflowX: 'auto' }}>
          <table className="month">
            <caption className="visually-hidden">Calendário de {title}</caption>
            <thead>
              <tr>
                {WEEKDAY_SHORT.map((d, i) => (
                  <th key={d} scope="col">
                    <abbr title={WEEKDAY_LONG[i]}>{d}</abbr>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map((weekRow) => (
                <tr key={weekRow[0]?.date}>
                  {weekRow.map((day) => {
                    const list = dated.get(day.date) ?? [];
                    return (
                      <td key={day.date} data-out={!day.inMonth} data-today={day.isToday}>
                        <span className="day-number">
                          <span className="visually-hidden">{formatDateLong(day.date)}</span>
                          <span aria-hidden="true">{Number(day.date.slice(8))}</span>
                          {day.isToday && <span className="visually-hidden"> (hoje)</span>}
                        </span>
                        {list.map((e) => (
                          <Chip key={e.id} event={e} />
                        ))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === 'semana' && (
        <div className="week">
          {week.map((day, i) => {
            const list = dated.get(day.date) ?? [];
            return (
              <section
                key={day.date}
                className="week-day"
                data-today={day.isToday}
                aria-label={formatDateLong(day.date)}
              >
                <h3>
                  {capitalizeFirst(WEEKDAY_LONG[i] ?? '')}, {formatDateShort(day.date)}
                  {day.isToday && ' (hoje)'}
                </h3>
                {list.length === 0 ? (
                  <p className="small muted">Sem eventos</p>
                ) : (
                  <ul className="list-plain">
                    {list.map((e) => (
                      <li key={e.id}>
                        <EventItem event={e} showDate={false} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      {(view === 'agenda' || view === 'mes') && result.ok && (
        <section className="card" aria-labelledby="agenda-title" style={{ marginTop: 16 }}>
          <h2 id="agenda-title">{view === 'mes' ? 'Eventos do período' : 'Agenda'}</h2>
          {dated.size === 0 ? (
            <EmptyState title="Nenhum evento no período" />
          ) : (
            [...dated.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([date, list]) => (
                <div key={date}>
                  <h3 style={{ marginTop: 12 }}>{capitalizeFirst(formatDateLong(date))}</h3>
                  <ul className="list-plain">
                    {list.map((e) => (
                      <li key={e.id}>
                        <EventItem event={e} showDate={false} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))
          )}
        </section>
      )}

      {undated.length > 0 && (
        <section className="card" aria-labelledby="undated-title">
          <h2 id="undated-title">Data a confirmar</h2>
          <ul className="list-plain">
            {undated.map((e) => (
              <li key={e.id}>
                <EventItem event={e} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <div style={{ marginTop: 16 }}>
        <CalendarFeed />
      </div>
    </>
  );
}
