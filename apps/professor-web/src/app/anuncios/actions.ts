'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  ApiError,
  confirmEvent,
  editEvent,
  getEvent,
  publishEvent,
  rejectEvent,
  type EventEdits,
} from '@/lib/api';
import { EVENT_TYPES } from '@/lib/types';

export interface ActionState {
  error?: string;
  fieldErrors?: Record<string, string>;
}

const text = (form: FormData, key: string): string => {
  const v = form.get(key);
  return typeof v === 'string' ? v.trim() : '';
};

const describe = (err: unknown): string =>
  err instanceof ApiError
    ? err.status === null
      ? err.message
      : `${err.message} (HTTP ${err.status})`
    : 'Erro inesperado. Tente novamente.';

function done(eventId: string, result: string): never {
  revalidatePath('/anuncios');
  revalidatePath(`/anuncios/${eventId}`);
  redirect(`/anuncios/${encodeURIComponent(eventId)}?resultado=${result}`);
}

export async function confirmAction(
  eventId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    await confirmEvent(eventId, text(form, 'notes') || undefined);
  } catch (err) {
    return { error: describe(err) };
  }
  done(eventId, 'confirmado');
}

export async function publishAction(
  eventId: string,
  _prev: ActionState,
  _form: FormData,
): Promise<ActionState> {
  try {
    await publishEvent(eventId);
  } catch (err) {
    return { error: describe(err) };
  }
  done(eventId, 'publicado');
}

export async function rejectAction(
  eventId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const reason = text(form, 'reason');
  if (reason.length < 3) {
    return { fieldErrors: { reason: 'Informe o motivo da rejeição (mínimo 3 caracteres).' } };
  }
  try {
    await rejectEvent(eventId, reason);
  } catch (err) {
    return { error: describe(err) };
  }
  done(eventId, 'rejeitado');
}

/** Edits imply confirmation (contract §5). Only changed fields are sent. */
export async function editAction(
  eventId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const fieldErrors: Record<string, string> = {};
  const title = text(form, 'title');
  const type = text(form, 'type');
  const eventDate = text(form, 'eventDate');
  const eventTime = text(form, 'eventTime');
  const description = text(form, 'description');
  const reason = text(form, 'reason');

  if (!title) fieldErrors.title = 'O título é obrigatório.';
  if (!(EVENT_TYPES as readonly string[]).includes(type)) fieldErrors.type = 'Tipo inválido.';
  if (eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) fieldErrors.eventDate = 'Data inválida.';
  if (eventTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(eventTime)) {
    fieldErrors.eventTime = 'Horário inválido (HH:mm).';
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  try {
    const current = await getEvent(eventId);
    const changes: EventEdits = {};
    if (title !== current.title) changes.title = title;
    if (type !== current.type) changes.type = type;
    if (eventDate && eventDate !== (current.eventDate ?? '')) changes.eventDate = eventDate;
    if (eventTime && eventTime !== (current.eventTime ?? '')) changes.eventTime = eventTime;
    if (description !== (current.description ?? '')) changes.description = description;
    if (Object.keys(changes).length === 0) {
      return { error: 'Nenhuma alteração detectada. Use “Confirmar” para aprovar sem mudanças.' };
    }
    if (current.dateResolution?.ambiguous && !eventDate && !current.eventDate) {
      return { fieldErrors: { eventDate: 'Defina a data: a IA não conseguiu determiná-la.' } };
    }
    await editEvent(eventId, changes, reason || undefined);
  } catch (err) {
    return { error: describe(err) };
  }
  done(eventId, 'editado');
}
