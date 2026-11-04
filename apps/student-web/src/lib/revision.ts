import type { RevisionCitation, RevisionKind } from './types';
import { transcriptAtMs, transcriptAtSegment } from './links';

export const KIND_LABELS: Record<RevisionKind, string> = {
  summary: 'Resumos das aulas',
  concept_review: 'Conceitos para revisar',
  flashcards: 'Cartões de memorização',
  quiz: 'Questões de múltipla escolha',
};

export const KIND_ORDER: RevisionKind[] = ['summary', 'concept_review', 'flashcards', 'quiz'];

/** SM-2 grades in plain language (0 = total blackout … 5 = perfect recall). */
export const GRADES: { grade: number; label: string; hint: string }[] = [
  { grade: 0, label: 'Não lembrei nada', hint: 'Vai aparecer de novo logo.' },
  { grade: 1, label: 'Errei, mas reconheci a resposta', hint: 'Vai aparecer de novo logo.' },
  { grade: 2, label: 'Errei, mas estava perto', hint: 'Vai aparecer de novo logo.' },
  { grade: 3, label: 'Acertei com muito esforço', hint: 'Intervalo curto até a próxima revisão.' },
  { grade: 4, label: 'Acertei com alguma hesitação', hint: 'Intervalo maior.' },
  { grade: 5, label: 'Acertei na hora', hint: 'Intervalo bem maior.' },
];

/** Plain-language explanations for the plan's `limitations` codes. */
export const LIMITATION_TEXT: Record<string, string> = {
  unknown_focus_concepts_ignored:
    'Alguns conceitos escolhidos não aparecem nas aulas selecionadas e foram ignorados.',
  no_lectures_in_scope:
    'Não há aulas processadas nas disciplinas e no período escolhidos. Amplie o período ou escolha outras disciplinas.',
  ai_materials_skipped_no_institution:
    'Cartões e questões não foram gerados (instituição não identificada). Resumos e conceitos estão disponíveis.',
  transcript_unavailable:
    'A transcrição de alguma aula não estava disponível, então os exercícios dessa aula não foram gerados.',
  ai_budget_exceeded:
    'O limite de uso de IA da instituição foi atingido. Cartões e questões não foram gerados desta vez.',
  ai_materials_unavailable:
    'O serviço de IA não respondeu. Cartões e questões não foram gerados; tente novamente mais tarde.',
  ai_materials_invalid:
    'Os exercícios gerados não passaram na verificação de fidelidade às aulas e foram descartados.',
};

export function limitationText(code: string): string {
  return LIMITATION_TEXT[code] ?? `Limitação registrada: ${code}.`;
}

export function citationHref(c: RevisionCitation): string | null {
  if (c.startMs !== undefined)
    return transcriptAtMs(c.scheduledClassId, c.startMs, c.segmentIndexes[0]);
  const first = c.segmentIndexes[0];
  return first !== undefined ? transcriptAtSegment(c.scheduledClassId, first) : null;
}

const RELATIVE = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });

export function nextReviewText(intervalDays: number): string {
  if (intervalDays <= 0) return 'Próxima revisão: ainda hoje.';
  return `Próxima revisão: ${RELATIVE.format(intervalDays, 'day')}.`;
}
