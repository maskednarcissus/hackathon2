'use server';

import { revalidatePath } from 'next/cache';
import { formText, type ActionState } from '../../lib/action-state';
import { COMMAND_LABELS, isCommandType, sendCommand } from '../../lib/console';
import { actorId } from '../../lib/http';

export async function sendCommandAction(
  deviceId: string,
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const type = formText(form, 'type');
  if (!isCommandType(type)) return { error: 'Selecione um comando válido.' };
  const res = await sendCommand(deviceId, type, actorId());
  if (!res.ok) return { error: res.error };
  revalidatePath(`/devices/${deviceId}`);
  revalidatePath('/devices');
  return {
    message: `Comando “${COMMAND_LABELS[type]}” enfileirado (${res.data.commandId.slice(0, 8)}). O dispositivo o recebe no próximo heartbeat; expira em 30 min.`,
  };
}
