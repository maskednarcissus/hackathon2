'use server';

import { revalidatePath } from 'next/cache';
import { UUID_RE, formText, type ActionState } from '../../lib/action-state';
import { createLegalHold, dsrAction, releaseLegalHold, runRetention } from '../../lib/governance';
import { actorId } from '../../lib/http';

const SCOPES = ['class_section', 'recording', 'subject'] as const;

export async function createHoldAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const type = formText(form, 'scopeType');
  const id = formText(form, 'scopeId');
  const reason = formText(form, 'reason');
  if (!(SCOPES as readonly string[]).includes(type))
    return { error: 'Escolha o escopo da retenção legal.' };
  if (!UUID_RE.test(id)) return { error: 'Informe o ID (UUID) do item retido.' };
  if (reason.length < 5) return { error: 'Informe o motivo (ex.: número do processo).' };
  const res = await createLegalHold(
    { type: type as (typeof SCOPES)[number], id },
    reason,
    actorId(),
  );
  if (!res.ok) return { error: res.error };
  revalidatePath('/governanca/retencao');
  return {
    message: 'Retenção legal registrada. Os itens não serão eliminados enquanto ela estiver ativa.',
  };
}

export async function releaseHoldAction(
  id: string,
  _p: ActionState,
  _f: FormData,
): Promise<ActionState> {
  const res = await releaseLegalHold(id);
  if (!res.ok) return { error: res.error };
  revalidatePath('/governanca/retencao');
  return { message: 'Retenção legal liberada.' };
}

export async function runRetentionAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const dryRun = form.get('dryRun') === 'on';
  if (!dryRun && formText(form, 'confirm') !== 'ELIMINAR') {
    return { error: 'Para executar a eliminação real, digite ELIMINAR no campo de confirmação.' };
  }
  const res = await runRetention(dryRun);
  if (!res.ok) return { error: res.error };
  revalidatePath('/governanca/retencao');
  return {
    message: dryRun
      ? `Simulação iniciada (job ${res.data.id.slice(0, 8)}). Nenhum dado foi eliminado.`
      : `Execução de retenção iniciada (job ${res.data.id.slice(0, 8)}).`,
  };
}

export async function dsrVerifyAction(
  id: string,
  _p: ActionState,
  form: FormData,
): Promise<ActionState> {
  const note = formText(form, 'note');
  const res = await dsrAction(id, 'verify', { actorId: actorId(), ...(note ? { note } : {}) });
  if (!res.ok) return { error: res.error };
  revalidatePath('/governanca/titulares');
  revalidatePath(`/governanca/titulares/${id}`);
  return { message: 'Identidade do titular verificada.' };
}

export async function dsrExecuteAction(
  id: string,
  _p: ActionState,
  _f: FormData,
): Promise<ActionState> {
  const res = await dsrAction(id, 'execute', { actorId: actorId() });
  if (!res.ok) return { error: res.error };
  revalidatePath('/governanca/titulares');
  revalidatePath(`/governanca/titulares/${id}`);
  return { message: 'Execução da solicitação iniciada nos serviços.' };
}

export async function dsrRejectAction(
  id: string,
  _p: ActionState,
  form: FormData,
): Promise<ActionState> {
  const reason = formText(form, 'reason');
  if (reason.length < 5)
    return { error: 'Informe o motivo da rejeição (será comunicado ao titular).' };
  const res = await dsrAction(id, 'reject', { actorId: actorId(), reason });
  if (!res.ok) return { error: res.error };
  revalidatePath('/governanca/titulares');
  revalidatePath(`/governanca/titulares/${id}`);
  return { message: 'Solicitação rejeitada.' };
}
