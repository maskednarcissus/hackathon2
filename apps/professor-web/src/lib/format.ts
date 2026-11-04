import type {
  AcademicEventType,
  CalendarConflict,
  ConfirmationStatus,
  ExtractionConfidence,
} from './types';

export const EVENT_TYPE_LABELS: Record<AcademicEventType, string> = {
  examination: 'Prova',
  quiz: 'Quiz / teste',
  assignment: 'Trabalho / entrega',
  project: 'Projeto',
  presentation: 'Apresentação / seminário',
  reading_deadline: 'Leitura obrigatória',
  class_cancellation: 'Aula cancelada',
  class_reschedule: 'Aula remarcada',
  room_change: 'Mudança de sala',
  other: 'Outro',
};

export const STATUS_LABELS: Record<ConfirmationStatus, string> = {
  suggested: 'Sugerido',
  awaiting_professor: 'Aguardando sua revisão',
  awaiting_admin: 'Aguardando administração',
  confirmed: 'Confirmado (não publicado)',
  published: 'Publicado no calendário',
  rejected: 'Rejeitado',
};

const FLAG_LABELS: Record<string, string> = {
  ambiguous_date: 'Data ambígua',
  hypothetical: 'Possível menção hipotética',
  past_date: 'Data no passado',
  injection_suspected: 'Texto suspeito de manipulação da IA',
  low_transcription_confidence: 'Baixa confiança na transcrição',
  conflict: 'Conflito de calendário',
};

export function flagLabel(flag: string): string {
  if (flag.startsWith('duplicate_of:')) return 'Possível duplicata de outro anúncio';
  return FLAG_LABELS[flag] ?? flag;
}

export const CONFIDENCE_LABELS: Record<keyof ExtractionConfidence, string> = {
  overall: 'Geral',
  transcription: 'Transcrição',
  eventClassification: 'Tipo de evento',
  dateInterpretation: 'Interpretação da data',
  courseAssociation: 'Associação à disciplina',
};

export const CONFLICT_SEVERITY_LABELS: Record<CalendarConflict['severity'], string> = {
  blocking: 'Bloqueante',
  warning: 'Atenção',
  info: 'Informativo',
};

export function confidenceLevel(value: number): 'alta' | 'média' | 'baixa' {
  if (value >= 0.92) return 'alta';
  if (value >= 0.7) return 'média';
  return 'baixa';
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** 2461000 → "00:41:01" */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** "2026-11-20" → "sexta-feira, 20/11/2026" (calendar date, not shifted by timezone). */
export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) return isoDate;
  const date = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function formatDateTime(iso: string, timeZone = 'America/Sao_Paulo'): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone,
  }).format(date);
}

export const FIELD_LABELS: Record<string, string> = {
  title: 'Título',
  type: 'Tipo',
  eventDate: 'Data',
  eventTime: 'Horário',
  description: 'Descrição',
  confirmationStatus: 'Status',
  status: 'Status',
};

export function transcriptLink(transcriptId: string, segmentIndex: number): string {
  return `/aulas/${encodeURIComponent(transcriptId)}/transcricao#seg-${segmentIndex}`;
}
