'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { identity, lectures, notifications, reports, calendar } from '@/lib/api';
import { calendarPublicUrl } from '@/lib/config';
import {
  clearSessionCookies,
  getRefreshToken,
  getSession,
  requireSession,
  setSessionCookies,
} from '@/lib/session';
import type {
  AssistantAnswer,
  NotificationCategory,
  NotificationPreferences,
  ReportReason,
  ReportResourceType,
} from '@/lib/types';

export interface FormState {
  status: 'idle' | 'success' | 'error';
  message?: string;
}

const str = (form: FormData, key: string): string => {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
};

/** Only same-origin relative paths are accepted as post-login targets (no open redirect). */
function safeNext(value: string): string {
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}

/* ---------------- auth ---------------- */

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  const email = str(form, 'email');
  const password = typeof form.get('password') === 'string' ? (form.get('password') as string) : '';
  const institutionId = str(form, 'institutionId') || (process.env['INSTITUTION_ID'] ?? '');
  if (email === '' || password === '') {
    return { status: 'error', message: 'Informe seu e-mail institucional e sua senha.' };
  }
  if (institutionId === '') {
    return { status: 'error', message: 'Instituição não configurada. Contate o suporte.' };
  }
  const result = await identity.login(email, password, institutionId);
  if (!result.ok) {
    if (result.status === 401 || result.status === 400) {
      return { status: 'error', message: 'E-mail ou senha incorretos.' };
    }
    if (result.status === 423 || result.status === 429) {
      return {
        status: 'error',
        message: 'Muitas tentativas sem sucesso. Aguarde 15 minutos e tente novamente.',
      };
    }
    return { status: 'error', message: result.message };
  }
  if (result.data.user.role !== 'student') {
    return {
      status: 'error',
      message:
        'Esta área é exclusiva para estudantes. Use o portal do professor ou da administração.',
    };
  }
  await setSessionCookies(result.data);
  redirect(safeNext(str(form, 'next')));
}

export async function logoutAction(): Promise<void> {
  const refreshToken = await getRefreshToken();
  if (refreshToken !== undefined) await identity.logout(refreshToken);
  await clearSessionCookies();
  redirect('/entrar');
}

/* ---------------- content reports (3.15) ---------------- */

const RESOURCE_TYPES: ReadonlySet<string> = new Set<ReportResourceType>([
  'lecture_summary',
  'concept',
  'transcript_segment',
  'calendar_event',
  'assistant_answer',
]);
const REASONS: ReadonlySet<string> = new Set<ReportReason>([
  'incorrect_date',
  'incorrect_content',
  'misattributed_statement',
  'transcription_error',
  'other',
]);

export async function submitReportAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await getSession();
  if (session === null) return { status: 'error', message: 'Sua sessão expirou. Entre novamente.' };
  const resourceType = str(form, 'resourceType');
  const reason = str(form, 'reason');
  const resourceId = str(form, 'resourceId');
  const classSectionId = str(form, 'classSectionId');
  const details = str(form, 'details');
  if (!RESOURCE_TYPES.has(resourceType) || resourceId === '') {
    return { status: 'error', message: 'Conteúdo inválido para denúncia.' };
  }
  if (!REASONS.has(reason)) return { status: 'error', message: 'Selecione o motivo.' };
  if (reason === 'other' && details === '') {
    return { status: 'error', message: 'Descreva o problema no campo de detalhes.' };
  }
  const result = await reports.create({
    reporterId: session.userId,
    reporterRole: 'student',
    institutionId: session.institutionId,
    resourceType: resourceType as ReportResourceType,
    resourceId,
    classSectionId,
    reason: reason as ReportReason,
    ...(details !== '' ? { details: details.slice(0, 2000) } : {}),
  });
  if (!result.ok) return { status: 'error', message: result.message };
  return {
    status: 'success',
    message: 'Obrigado! Sua indicação foi enviada ao professor para revisão.',
  };
}

/* ---------------- assistant (3.13, 3.14) ---------------- */

export type AskResult = { ok: true; answer: AssistantAnswer } | { ok: false; message: string };

export async function askAssistantAction(input: {
  question: string;
  conversationId?: string;
  scheduledClassId?: string;
}): Promise<AskResult> {
  const session = await getSession();
  if (session === null) return { ok: false, message: 'Sua sessão expirou. Entre novamente.' };
  const question = input.question.trim().slice(0, 2000);
  if (question === '') return { ok: false, message: 'Digite uma pergunta.' };
  const sections = await identity.sections();
  if (!sections.ok) return { ok: false, message: sections.message };
  const result = await lectures.ask({
    question,
    studentId: session.studentId,
    institutionId: session.institutionId,
    classSectionIds: sections.data,
    ...(input.scheduledClassId !== undefined ? { scheduledClassId: input.scheduledClassId } : {}),
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
  });
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, answer: result.data };
}

export async function assistantFeedbackAction(
  answerId: string,
  helpful: boolean,
): Promise<boolean> {
  const session = await getSession();
  if (session === null) return false;
  const result = await lectures.feedback(answerId, helpful);
  return result.ok;
}

/* ---------------- notifications (3.11, 3.12) ---------------- */

export async function markNotificationReadAction(form: FormData): Promise<void> {
  const session = await requireSession();
  const id = str(form, 'id');
  if (id !== '') await notifications.markRead(session.userId, id);
  revalidatePath('/notificacoes');
}

export async function markAllNotificationsReadAction(): Promise<void> {
  const session = await requireSession();
  await notifications.markAllRead(session.userId);
  revalidatePath('/notificacoes');
}

const CATEGORIES: NotificationCategory[] = [
  'new_assessment',
  'deadline_change',
  'class_cancellation',
  'lecture_summary',
  'reminder',
];
/** In-app delivery cannot be disabled for these (contract §6). */
const CRITICAL: ReadonlySet<NotificationCategory> = new Set([
  'deadline_change',
  'class_cancellation',
]);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function savePreferencesAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await getSession();
  if (session === null) return { status: 'error', message: 'Sua sessão expirou. Entre novamente.' };
  const categories = {} as NotificationPreferences['categories'];
  for (const category of CATEGORIES) {
    categories[category] = {
      in_app: CRITICAL.has(category) || form.get(`${category}.in_app`) === 'on',
      email: form.get(`${category}.email`) === 'on',
      push: form.get(`${category}.push`) === 'on',
    };
  }
  let quietHours: NotificationPreferences['quietHours'] = null;
  if (form.get('quietEnabled') === 'on') {
    const start = str(form, 'quietStart');
    const end = str(form, 'quietEnd');
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
      return { status: 'error', message: 'Informe o horário de silêncio no formato HH:MM.' };
    }
    quietHours = { start, end, timezone: str(form, 'timezone') || 'America/Sao_Paulo' };
  }
  const reminderOffsetsHours = form
    .getAll('reminder')
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 24 * 14)
    .sort((a, b) => b - a);
  const result = await notifications.savePreferences(session.userId, {
    categories,
    quietHours,
    reminderOffsetsHours,
  });
  if (!result.ok) return { status: 'error', message: result.message };
  revalidatePath('/preferencias');
  return { status: 'success', message: 'Preferências salvas.' };
}

export async function savePushSubscriptionAction(subscription: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}): Promise<{ ok: boolean; message?: string }> {
  const session = await getSession();
  if (session === null) return { ok: false, message: 'Sua sessão expirou.' };
  if (!subscription.endpoint.startsWith('https://')) {
    return { ok: false, message: 'Assinatura de notificação inválida.' };
  }
  const result = await notifications.addPushSubscription(session.userId, subscription);
  return result.ok ? { ok: true } : { ok: false, message: result.message };
}

/* ---------------- calendar export (3.10) ---------------- */

export async function createCalendarFeedAction(): Promise<
  { ok: true; url: string } | { ok: false; message: string }
> {
  const session = await getSession();
  if (session === null) return { ok: false, message: 'Sua sessão expirou.' };
  const result = await calendar.feedToken(session.studentId);
  if (!result.ok) return { ok: false, message: result.message };
  const url =
    result.data.feedUrl ??
    `${calendarPublicUrl}/v1/students/${encodeURIComponent(session.studentId)}/calendar.ics?token=${encodeURIComponent(result.data.token)}`;
  return { ok: true, url };
}
