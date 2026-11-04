'use server';

import { revalidatePath } from 'next/cache';
import { UUID_RE, formText, type ActionState } from '../../lib/action-state';
import { actorId } from '../../lib/http';
import {
  RESOLUTION_CODES,
  assignIncident,
  commentIncident,
  resolveIncident,
  setIncidentStatus,
  type ResolutionCode,
} from '../../lib/incidents';

const refresh = (id: string): void => {
  revalidatePath('/incidentes');
  revalidatePath(`/incidentes/${id}`);
  revalidatePath('/');
};

export async function assignAction(
  id: string,
  _p: ActionState,
  form: FormData,
): Promise<ActionState> {
  const assignee = formText(form, 'assigneeId') || actorId();
  if (!UUID_RE.test(assignee)) return { error: 'Informe o ID (UUID) do responsável.' };
  const res = await assignIncident(id, assignee, actorId());
  if (!res.ok) return { error: res.error };
  refresh(id);
  return { message: 'Responsável atribuído.' };
}

export async function statusAction(
  id: string,
  _p: ActionState,
  form: FormData,
): Promise<ActionState> {
  const status = formText(form, 'status');
  if (status !== 'acknowledged' && status !== 'in_progress') return { error: 'Status inválido.' };
  const res = await setIncidentStatus(id, status, actorId());
  if (!res.ok) return { error: res.error };
  refresh(id);
  return {
    message: status === 'acknowledged' ? 'Incidente reconhecido.' : 'Incidente em andamento.',
  };
}

export async function commentAction(
  id: string,
  _p: ActionState,
  form: FormData,
): Promise<ActionState> {
  const body = formText(form, 'body');
  if (body.length < 2) return { error: 'Escreva um comentário.' };
  if (body.length > 4000) return { error: 'Comentário muito longo (máx. 4000 caracteres).' };
  const res = await commentIncident(id, body, actorId());
  if (!res.ok) return { error: res.error };
  refresh(id);
  return { message: 'Comentário adicionado.' };
}

export async function resolveAction(
  id: string,
  _p: ActionState,
  form: FormData,
): Promise<ActionState> {
  const code = formText(form, 'resolutionCode');
  const note = formText(form, 'note');
  if (!(RESOLUTION_CODES as readonly string[]).includes(code)) {
    return { error: 'Selecione o código de resolução.' };
  }
  if (code === 'other' && note.length < 3)
    return { error: 'Descreva a resolução quando o código for “Outro”.' };
  const res = await resolveIncident(id, code as ResolutionCode, note || undefined, actorId());
  if (!res.ok) return { error: res.error };
  refresh(id);
  return { message: 'Incidente resolvido.' };
}
