/** pt-BR labels for Phase 4 enumerations (pure; safe on server and client). */

const lookup =
  (table: Record<string, string>) =>
  (key: string | null | undefined): string =>
    key == null ? '—' : (table[key] ?? key.replace(/_/g, ' '));

export const severityLabel = lookup({
  critical: 'Crítica',
  high: 'Alta',
  medium: 'Média',
  low: 'Baixa',
  blocking: 'Bloqueante',
  warning: 'Atenção',
  info: 'Informativa',
});

export const SEVERITY_ICON: Record<string, string> = {
  critical: '‼',
  high: '!',
  medium: '•',
  low: '·',
  blocking: '⛔',
  warning: '⚠',
  info: 'ℹ',
};

export const SEVERITY_TONE: Record<string, 'danger' | 'warning' | 'info' | 'muted'> = {
  critical: 'danger',
  high: 'danger',
  blocking: 'danger',
  medium: 'warning',
  warning: 'warning',
  low: 'muted',
  info: 'info',
};

export const incidentStatusLabel = lookup({
  open: 'Aberto',
  acknowledged: 'Reconhecido',
  in_progress: 'Em andamento',
  resolved: 'Resolvido',
});

export const incidentTypeLabel = lookup({
  device_offline: 'Dispositivo offline',
  recording_missed: 'Gravação não iniciada',
  failed_upload: 'Falha de envio',
  poor_audio_quality: 'Áudio de baixa qualidade',
  transcription_failure: 'Falha de transcrição',
  low_storage: 'Armazenamento baixo',
});

export const resolutionLabel = lookup({
  hardware_replaced: 'Hardware substituído',
  network_fixed: 'Rede corrigida',
  configuration: 'Configuração',
  false_positive: 'Falso positivo',
  class_cancelled: 'Aula cancelada',
  other: 'Outro',
});

export const conflictKindLabel = lookup({
  assessment_overlap_shared_students: 'Avaliações no mesmo dia com alunos em comum',
  assessment_load: 'Sobrecarga de avaliações',
  same_day_same_program: 'Avaliações do mesmo curso no mesmo dia',
});

export const coverageStatusLabel = lookup({
  covered: 'Coberto',
  partial: 'Parcial',
  not_covered: 'Não coberto',
});

export const COVERAGE_ICON: Record<string, string> = {
  covered: '✓',
  partial: '◐',
  not_covered: '✕',
};

export const assessmentTypeLabel = lookup({
  examination: 'Prova',
  quiz: 'Quiz',
  assignment: 'Trabalho',
  project: 'Projeto',
  presentation: 'Apresentação',
  reading_deadline: 'Leitura',
});

export const assessmentStatusLabel = lookup({
  published: 'Publicado',
  awaiting_review: 'Aguardando revisão',
  confirmed: 'Confirmado',
});

export const dsrTypeLabel = lookup({
  access: 'Acesso',
  correction: 'Correção',
  deletion: 'Eliminação',
  anonymization: 'Anonimização',
  restriction: 'Restrição',
});

export const dsrStatusLabel = lookup({
  received: 'Recebida',
  verifying: 'Em verificação',
  in_progress: 'Em execução',
  completed: 'Concluída',
  rejected: 'Rejeitada',
});

export const retentionKindLabel = lookup({
  audio: 'Áudio',
  transcript: 'Transcrições',
  summary: 'Resumos',
  extracted_event: 'Eventos extraídos',
});

export const commandStatusLabel = lookup({
  pending: 'Pendente',
  delivered: 'Entregue',
  succeeded: 'Concluído',
  failed: 'Falhou',
  expired: 'Expirado',
});

export const holdScopeLabel = lookup({
  class_section: 'Turma',
  recording: 'Gravação',
  subject: 'Titular',
});

export function formatPercent(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: digits })}%`;
}

export function formatMinutes(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return '—';
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60;
  return h < 48
    ? `${h.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h`
    : `${Math.round(h / 24)} d`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

export function formatWeekday(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    timeZone: 'UTC',
  });
}
