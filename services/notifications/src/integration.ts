import { z } from 'zod';
import { HttpError } from './http.js';
import { ClassWindowSchema, DeviceSnapshotSchema } from './schemas.js';
import type { StudentStore, UserDataDeletion, UserDataExport } from './student/store.js';

// ---------------------------------------------------------------------------
// Event bus (integration stage §2): Pub/Sub push or raw envelope
// ---------------------------------------------------------------------------

const PushMessageSchema = z.object({
  message: z.object({
    data: z.string().min(1),
    messageId: z.string().optional(),
    attributes: z.record(z.string()).optional(),
  }),
  subscription: z.string().optional(),
});

/** Accepts `{ message: { data: base64(envelope) }, subscription }` or the envelope itself. */
export function unwrapPushBody(body: unknown): unknown {
  const push = PushMessageSchema.safeParse(body);
  if (!push.success) return body;
  try {
    return JSON.parse(Buffer.from(push.data.message.data, 'base64').toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_push_message', 'message.data is not base64-encoded JSON');
  }
}

// ---------------------------------------------------------------------------
// Alert context (integration stage §6): class windows + device snapshots for /v1/alerts/evaluate
// ---------------------------------------------------------------------------

export const AlertContextSchema = z.object({
  classWindows: z.array(ClassWindowSchema).default([]),
  devices: z.array(DeviceSnapshotSchema).default([]),
});
export type AlertContext = z.infer<typeof AlertContextSchema>;

export interface AlertContextClient {
  fetch(now: Date): Promise<AlertContext>;
}

/** `GET {ACADEMIC_INTEGRATION_URL}/internal/v1/alert-context?now=<iso>` with `x-internal-token`. */
export class HttpAlertContextClient implements AlertContextClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetch(now: Date): Promise<AlertContext> {
    const url = new URL('/internal/v1/alert-context', this.baseUrl);
    url.searchParams.set('now', now.toISOString());
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.internalToken) headers['x-internal-token'] = this.internalToken;
    const res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`alert-context responded ${res.status}`);
    const parsed = AlertContextSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error('alert-context returned an invalid body');
    return parsed.data;
  }
}

// ---------------------------------------------------------------------------
// Data subject rights (integration stage §5, Phase 4 §6)
// ---------------------------------------------------------------------------

export const DSR_TYPES = [
  'access',
  'correction',
  'deletion',
  'anonymization',
  'restriction',
] as const;
export type DsrType = (typeof DSR_TYPES)[number];

export const DsrPayloadSchema = z.object({
  subjectType: z.enum(['student', 'professor', 'user']),
  subjectId: z.string().min(1).max(100),
  requestId: z.string().min(1).max(100),
  institutionId: z.string().min(1).max(100),
  details: z.record(z.unknown()).optional(),
});
export type DsrPayload = z.infer<typeof DsrPayloadSchema>;

export interface DsrResult {
  service: 'notifications';
  status: 'completed' | 'not_applicable' | 'failed';
  items: unknown;
  error?: string;
}

/**
 * Notification data of a subject = inbox, preferences, push subscriptions (and the e-mail kept in the
 * enrollment mirror). The subject is resolved to identity user ids: `user` → subjectId;
 * `student` → user ids synced for that studentId (+ subjectId itself and `details.userId`).
 */
export async function handleDsr(
  store: StudentStore,
  type: DsrType,
  p: DsrPayload,
): Promise<DsrResult> {
  if (type === 'correction' || type === 'restriction') {
    return {
      service: 'notifications',
      status: 'not_applicable',
      items: {
        reason:
          type === 'correction'
            ? 'notifications are derived from academic records; correct the source (calendar / identity)'
            : 'restriction is enforced by identity (account) and preferences (channels)',
      },
    };
  }
  const userIds = new Set<string>([p.subjectId]);
  if (typeof p.details?.userId === 'string') userIds.add(p.details.userId);
  if (p.subjectType === 'student') {
    for (const id of await store.findUserIdsByStudent(p.subjectId)) userIds.add(id);
  }
  if (type === 'access') {
    const subjects: ({ userId: string } & UserDataExport)[] = [];
    for (const userId of userIds) {
      const data = await store.exportUserData(userId);
      if (
        data.notifications.length ||
        data.preferences ||
        data.pushSubscriptions.length ||
        data.enrollments.length
      ) {
        subjects.push({ userId, ...data });
      }
    }
    return { service: 'notifications', status: 'completed', items: { subjects } };
  }
  // deletion | anonymization: notifications are personal data with no archival value → delete
  const deleted: ({ userId: string } & UserDataDeletion)[] = [];
  for (const userId of userIds) deleted.push({ userId, ...(await store.deleteUserData(userId)) });
  return { service: 'notifications', status: 'completed', items: { deleted } };
}
