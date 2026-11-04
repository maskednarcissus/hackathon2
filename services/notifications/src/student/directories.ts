import type { StudentStore } from './store.js';
import type { Recipient } from './types.js';

/** Who must be notified for a class section (students with an `active` enrollment). */
export interface EnrollmentDirectory {
  activeRecipients(classSectionId: string): Promise<Recipient[]>;
}

/** Mirror fed by `POST /v1/sync/enrollments` (academic-integration / identity push). */
export class LocalEnrollmentDirectory implements EnrollmentDirectory {
  constructor(private readonly store: StudentStore) {}

  async activeRecipients(classSectionId: string): Promise<Recipient[]> {
    const seen = new Set<string>();
    const result: Recipient[] = [];
    for (const e of await this.store.listEnrollments(classSectionId)) {
      if (e.status !== 'active' || seen.has(e.userId)) continue;
      seen.add(e.userId);
      result.push({
        userId: e.userId,
        studentId: e.studentId,
        institutionId: e.institutionId,
        email: e.email,
      });
    }
    return result;
  }
}

/** Calendar event as returned by calendar `GET /v1/calendar-events/:id`. */
export interface CalendarEventDetails {
  id: string;
  institutionId: string | null;
  courseId: string | null;
  classSectionId: string;
  extractedEventId: string | null;
  type: string;
  title: string;
  eventDate: string;
  eventTime: string | null;
  timezone: string;
  status: string;
  version: number;
}

export interface CalendarEventSource {
  get(calendarEventId: string): Promise<CalendarEventDetails | undefined>;
}

export interface ScheduledClassInfo {
  id: string;
  classSectionId: string;
  courseId?: string | null;
  localDate?: string | null;
  institutionId?: string | null;
}

export interface ClassDirectory {
  getScheduledClass(scheduledClassId: string): Promise<ScheduledClassInfo | undefined>;
}

async function getJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token?: string,
): Promise<T | undefined> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(5_000) });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return (await res.json()) as T;
}

export class HttpCalendarEventSource implements CalendarEventSource {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  get(id: string): Promise<CalendarEventDetails | undefined> {
    return getJson<CalendarEventDetails>(
      this.fetchImpl,
      `${this.baseUrl.replace(/\/$/, '')}/v1/calendar-events/${encodeURIComponent(id)}`,
      this.token,
    );
  }
}

export class HttpClassDirectory implements ClassDirectory {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  getScheduledClass(id: string): Promise<ScheduledClassInfo | undefined> {
    return getJson<ScheduledClassInfo>(
      this.fetchImpl,
      `${this.baseUrl.replace(/\/$/, '')}/v1/scheduled-classes/${encodeURIComponent(id)}`,
      this.token,
    );
  }
}

export class MapCalendarEventSource implements CalendarEventSource {
  readonly events = new Map<string, CalendarEventDetails>();
  get(id: string): Promise<CalendarEventDetails | undefined> {
    const e = this.events.get(id);
    return Promise.resolve(e ? structuredClone(e) : undefined);
  }
}

export class MapClassDirectory implements ClassDirectory {
  readonly classes = new Map<string, ScheduledClassInfo>();
  getScheduledClass(id: string): Promise<ScheduledClassInfo | undefined> {
    return Promise.resolve(this.classes.get(id));
  }
}
