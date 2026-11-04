/**
 * Typed upstream clients used by the student BFF (server components and server actions).
 * Endpoints follow docs/architecture/phase-{1,2,3}-*.md.
 */
import { request, type ApiResult } from './http';
import type {
  AppNotification,
  AssistantAnswer,
  CalendarChange,
  CalendarEvent,
  DueItems,
  FeedToken,
  LectureList,
  LectureStructure,
  LoginResponse,
  NotificationPreferences,
  ReportReason,
  ReportResourceType,
  ReviewResult,
  RevisionPlan,
  SearchResult,
  SectionsResponse,
  Transcript,
  TranscriptSegment,
  User,
} from './types';

/** Accepts `T[]`, `{ items: T[] }`, `{ <key>: T[] }` — services paginate slightly differently. */
function listFrom<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data !== null && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const value = record[key] ?? record['items'] ?? record['data'];
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

function mapResult<T, U>(result: ApiResult<T>, fn: (data: T) => U): ApiResult<U> {
  return result.ok ? { ok: true, status: result.status, data: fn(result.data) } : result;
}

/* ---------------- identity ---------------- */

export const identity = {
  login: (
    email: string,
    password: string,
    institutionId: string,
  ): Promise<ApiResult<LoginResponse>> =>
    request<LoginResponse>('identity', '/v1/auth/login', {
      method: 'POST',
      auth: false,
      body: { email, password, institutionId },
    }),
  logout: (refreshToken: string): Promise<ApiResult<void>> =>
    request<void>('identity', '/v1/auth/logout', { method: 'POST', body: { refreshToken } }),
  me: (): Promise<ApiResult<User>> => request<User>('identity', '/v1/me'),
  sections: async (): Promise<ApiResult<string[]>> =>
    mapResult(await request<SectionsResponse | string[]>('identity', '/v1/me/sections'), (d) =>
      Array.isArray(d) ? d : d.classSectionIds,
    ),
};

/* ---------------- lectures & assistant ---------------- */

export interface LectureQuery {
  classSectionIds: string[];
  q?: string;
  courseId?: string;
  from?: string;
  to?: string;
  sort?: 'recent' | 'oldest' | 'course';
  page?: number;
  pageSize?: number;
}

export const lectures = {
  list: (query: LectureQuery): Promise<ApiResult<LectureList>> =>
    request<LectureList>('lectures', '/v1/lectures', {
      query: {
        classSectionIds: query.classSectionIds.join(','),
        q: query.q,
        courseId: query.courseId,
        from: query.from,
        to: query.to,
        sort: query.sort,
        page: query.page,
        pageSize: query.pageSize,
      },
    }),
  get: (scheduledClassId: string): Promise<ApiResult<LectureStructure>> =>
    request<LectureStructure>('lectures', `/v1/lectures/${encodeURIComponent(scheduledClassId)}`),
  ask: (body: {
    question: string;
    studentId: string;
    institutionId: string;
    classSectionIds: string[];
    scheduledClassId?: string;
    conversationId?: string;
  }): Promise<ApiResult<AssistantAnswer>> =>
    request<AssistantAnswer>('lectures', '/v1/assistant/ask', {
      method: 'POST',
      body,
      timeoutMs: 60_000,
    }),
  feedback: (answerId: string, helpful: boolean, comment?: string): Promise<ApiResult<void>> =>
    request<void>('lectures', '/v1/assistant/feedback', {
      method: 'POST',
      body: { answerId, helpful, ...(comment !== undefined ? { comment } : {}) },
    }),
};

/* ---------------- revision (Phase 6 §6.2) ---------------- */

export const revision = {
  createPlan: (body: {
    studentId: string;
    institutionId: string;
    classSectionIds: string[];
    from?: string;
    to?: string;
    focus?: string[];
  }): Promise<ApiResult<RevisionPlan>> =>
    request<RevisionPlan>('lectures', '/v1/revision/plans', {
      method: 'POST',
      body,
      timeoutMs: 120_000,
    }),
  getPlan: (planId: string, studentId: string): Promise<ApiResult<RevisionPlan>> =>
    request<RevisionPlan>('lectures', `/v1/revision/plans/${encodeURIComponent(planId)}`, {
      query: { studentId },
    }),
  review: (itemId: string, grade: number, studentId: string): Promise<ApiResult<ReviewResult>> =>
    request<ReviewResult>('lectures', '/v1/revision/reviews', {
      method: 'POST',
      body: { itemId, grade, studentId },
    }),
  due: (studentId: string, limit = 30): Promise<ApiResult<DueItems>> =>
    request<DueItems>('lectures', '/v1/revision/due', { query: { studentId, limit } }),
};

/* ---------------- transcripts & search ---------------- */

export const transcripts = {
  get: (transcriptId: string): Promise<ApiResult<Transcript>> =>
    request<Transcript>('transcripts', `/v1/transcripts/${encodeURIComponent(transcriptId)}`),
  /** Loads every segment, following pagination (`nextCursor`/`cursor` or `offset`). */
  segments: async (transcriptId: string): Promise<ApiResult<TranscriptSegment[]>> => {
    const all: TranscriptSegment[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await request<unknown>(
        'transcripts',
        `/v1/transcripts/${encodeURIComponent(transcriptId)}/segments`,
        { query: { cursor, limit: 500 } },
      );
      if (!result.ok) return result;
      all.push(...listFrom<TranscriptSegment>(result.data, 'segments'));
      const data = result.data as Record<string, unknown> | null;
      const next = data !== null && typeof data === 'object' ? data['nextCursor'] : undefined;
      if (typeof next !== 'string' || next === '') break;
      cursor = next;
    }
    return { ok: true, status: 200, data: all.sort((a, b) => a.startMs - b.startMs) };
  },
  search: async (
    q: string,
    classSectionIds: string[],
    limit = 20,
  ): Promise<ApiResult<SearchResult[]>> =>
    mapResult(
      await request<unknown>('transcripts', '/v1/search', {
        query: { q, classSectionIds: classSectionIds.join(','), limit, mode: 'hybrid' },
      }),
      (d) => listFrom<SearchResult>(d, 'results'),
    ),
};

/* ---------------- calendar ---------------- */

export const calendar = {
  studentEvents: async (
    studentId: string,
    from: string,
    to: string,
  ): Promise<ApiResult<CalendarEvent[]>> =>
    mapResult(
      await request<unknown>(
        'calendar',
        `/v1/students/${encodeURIComponent(studentId)}/calendar-events`,
        { query: { from, to } },
      ),
      (d) => listFrom<CalendarEvent>(d, 'events'),
    ),
  event: (eventId: string): Promise<ApiResult<CalendarEvent>> =>
    request<CalendarEvent>('calendar', `/v1/calendar-events/${encodeURIComponent(eventId)}`),
  history: async (eventId: string): Promise<ApiResult<CalendarChange[]>> =>
    mapResult(
      await request<unknown>(
        'calendar',
        `/v1/calendar-events/${encodeURIComponent(eventId)}/history`,
        { query: { view: 'student' } },
      ),
      (d) => listFrom<CalendarChange>(d, 'history'),
    ),
  feedToken: (studentId: string): Promise<ApiResult<FeedToken>> =>
    request<FeedToken>(
      'calendar',
      `/v1/students/${encodeURIComponent(studentId)}/calendar-feed-token`,
      { method: 'POST', body: {} },
    ),
};

/* ---------------- notifications ---------------- */

export const notifications = {
  list: async (userId: string, unreadOnly = false): Promise<ApiResult<AppNotification[]>> =>
    mapResult(
      await request<unknown>(
        'notifications',
        `/v1/users/${encodeURIComponent(userId)}/notifications`,
        {
          query: { unread: unreadOnly ? 'true' : undefined },
        },
      ),
      (d) => listFrom<AppNotification>(d, 'notifications'),
    ),
  markRead: (userId: string, id: string): Promise<ApiResult<void>> =>
    request<void>(
      'notifications',
      `/v1/users/${encodeURIComponent(userId)}/notifications/${encodeURIComponent(id)}/read`,
      { method: 'POST', body: {} },
    ),
  markAllRead: (userId: string): Promise<ApiResult<void>> =>
    request<void>(
      'notifications',
      `/v1/users/${encodeURIComponent(userId)}/notifications/read-all`,
      { method: 'POST', body: {} },
    ),
  preferences: (userId: string): Promise<ApiResult<NotificationPreferences>> =>
    request<NotificationPreferences>(
      'notifications',
      `/v1/users/${encodeURIComponent(userId)}/notification-preferences`,
    ),
  savePreferences: (
    userId: string,
    prefs: NotificationPreferences,
  ): Promise<ApiResult<NotificationPreferences>> =>
    request<NotificationPreferences>(
      'notifications',
      `/v1/users/${encodeURIComponent(userId)}/notification-preferences`,
      { method: 'PUT', body: prefs },
    ),
  addPushSubscription: (
    userId: string,
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  ): Promise<ApiResult<void>> =>
    request<void>('notifications', `/v1/users/${encodeURIComponent(userId)}/push-subscriptions`, {
      method: 'POST',
      body: subscription,
    }),
};

/* ---------------- content reports ---------------- */

export const reports = {
  create: (body: {
    reporterId: string;
    reporterRole: 'student';
    institutionId: string;
    resourceType: ReportResourceType;
    resourceId: string;
    classSectionId: string;
    reason: ReportReason;
    details?: string;
  }): Promise<ApiResult<{ id: string }>> =>
    request<{ id: string }>('audit', '/v1/content-reports', { method: 'POST', body }),
};
