'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, correctSegment } from '@/lib/api';

export interface CorrectionState {
  ok?: boolean;
  error?: string;
}

export async function correctSegmentAction(
  transcriptId: string,
  segmentIndex: number,
  currentText: string,
  _prev: CorrectionState,
  form: FormData,
): Promise<CorrectionState> {
  const raw = form.get('correctedText');
  const reasonRaw = form.get('reason');
  const correctedText = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
  if (!correctedText) return { error: 'O texto corrigido não pode ficar vazio.' };
  if (correctedText.length > 5000) return { error: 'Texto muito longo (máx. 5000 caracteres).' };
  if (correctedText === currentText.trim()) return { error: 'O texto não foi alterado.' };
  try {
    await correctSegment(transcriptId, segmentIndex, correctedText, reason || undefined);
  } catch (err) {
    return {
      error:
        err instanceof ApiError
          ? `${err.message}${err.status !== null ? ` (HTTP ${err.status})` : ''}`
          : 'Erro inesperado ao salvar a correção.',
    };
  }
  revalidatePath(`/aulas/${transcriptId}/transcricao`);
  return { ok: true };
}
