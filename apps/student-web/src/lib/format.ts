import { DEFAULT_TIMEZONE } from './config';
import type {
  AcademicEventType,
  CalendarEvent,
  ConfirmationStatus,
  EventProvenance,
} from './types';

/** 3_725_000 → "01:02:05" (always hh:mm:ss so anchors line up). */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Human duration for screen readers: "1 hora, 2 minutos e 5 segundos". */
export function spokenTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const parts: string[] = [];
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) parts.push(`${h} ${h === 1 ? 'hora' : 'horas'}`);
  if (m > 0) parts.push(`${m} ${m === 1 ? 'minuto' : 'minutos'}`);
  if (s > 0 || parts.length === 0) parts.push(`${s} ${s === 1 ? 'segundo' : 'segundos'}`);
  if (parts.length === 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1] ?? ''}`;
}

/** Parses a "YYYY-MM-DD" calendar date as a UTC-noon Date (safe from timezone shifts). */
export function parseDateOnly(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12));
}

export function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const longDate = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const shortDate = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'short',
  timeZone: 'UTC',
});

export function formatDateLong(dateOnly: string): string {
  return longDate.format(parseDateOnly(dateOnly));
}

export function formatDateShort(dateOnly: string): string {
  return shortDate.format(parseDateOnly(dateOnly));
}

/** ISO instant → "04/11/2026 19:00" in the campus timezone. */
export function formatDateTime(iso: string, timeZone = DEFAULT_TIMEZONE): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone,
  }).format(date);
}

export function formatClassDate(iso: string, timeZone = DEFAULT_TIMEZONE): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone,
  }).format(date);
}

export const EVENT_TYPE_LABELS: Record<AcademicEventType, string> = {
  examination: 'Prova',
  quiz: 'Quiz',
  assignment: 'Trabalho',
  project: 'Projeto',
  presentation: 'Apresentação',
  reading_deadline: 'Leitura',
  class_cancellation: 'Aula cancelada',
  class_reschedule: 'Aula remarcada',
  room_change: 'Mudança de sala',
  other: 'Outro',
};

export const ASSESSMENT_TYPES: ReadonlySet<AcademicEventType> = new Set([
  'examination',
  'quiz',
  'assignment',
  'project',
  'presentation',
  'reading_deadline',
]);

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export function eventStatus(event: CalendarEvent): { label: string; tone: StatusTone } {
  const status: ConfirmationStatus | 'cancelled' | undefined = event.status;
  if (status === 'cancelled' || event.type === 'class_cancellation') {
    return { label: 'Cancelado', tone: 'danger' };
  }
  if (event.isOfficial) return { label: 'Oficial', tone: 'success' };
  switch (status) {
    case 'published':
    case 'confirmed':
      return { label: 'Confirmado pelo professor', tone: 'success' };
    case 'awaiting_professor':
    case 'awaiting_admin':
    case 'suggested':
      return { label: 'Aguardando confirmação', tone: 'warning' };
    case 'rejected':
      return { label: 'Descartado', tone: 'neutral' };
    default:
      return { label: 'Publicado', tone: 'info' };
  }
}

export const CHANGE_FIELD_LABELS: Record<string, string> = {
  eventDate: 'Data',
  event_date: 'Data',
  eventTime: 'Horário',
  event_time: 'Horário',
  title: 'Título',
  description: 'Descrição',
  status: 'Situação',
  type: 'Tipo',
};

/** Speaker labels are anonymous (`SPEAKER_n`) — render as "Pessoa n", never an identity. */
export function speakerName(label: string | undefined): string | null {
  if (label === undefined) return null;
  const match = /^SPEAKER_(\d+)$/.exec(label);
  return match ? `Pessoa ${match[1] ?? ''}` : null;
}

export function pluralize(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "quinta-feira, 5 de novembro" → "Quinta-feira, 5 de novembro" (CSS capitalize would yield "De"). */
export function capitalizeFirst(text: string): string {
  return text.charAt(0).toLocaleUpperCase('pt-BR') + text.slice(1);
}

/** Student calendar items carry `source`; the detail endpoint carries `provenance`. */
export function eventSource(event: CalendarEvent): EventProvenance | undefined {
  return event.source ?? event.provenance ?? undefined;
}
