/**
 * Academic data synchronisation (integration-stage contract §3): after every applied import (and on
 * `POST /v1/sync/push`) the canonical sections / enrollments / classrooms of an institution are pushed
 * to every SYNC_TARGETS entry, mapped to that service's existing sync body.
 */
import type { ClassroomDirectory, ClassroomInfo } from './clients.js';
import type { AcademicRepository } from './repository.js';

export type TargetKind = 'identity' | 'calendar' | 'notifications' | 'analytics';

export interface SyncTarget {
  name: string;
  kind: TargetKind;
  url: string;
}

/** `identity=http://identity:4001,calendar=http://calendar:4005,…` — kind inferred from the name. */
export function parseSyncTargets(value: string | undefined): SyncTarget[] {
  if (!value?.trim()) return [];
  return value.split(',').map((pair) => {
    const [rawName, ...rest] = pair.trim().split('=');
    const name = (rawName ?? '').trim();
    const url = rest.join('=').trim().replace(/\/+$/, '');
    const kind: TargetKind | undefined = name.includes('identity')
      ? 'identity'
      : name.includes('calendar')
        ? 'calendar'
        : name.includes('notification')
          ? 'notifications'
          : name.includes('analytics')
            ? 'analytics'
            : undefined;
    if (!kind || !/^https?:\/\//.test(url)) throw new Error(`Invalid SYNC_TARGETS entry "${pair}"`);
    return { name, kind, url };
  });
}

// ---------------------------------------------------------------- canonical payload

export interface CanonicalSection {
  classSectionId: string;
  institutionId: string;
  courseId: string;
  courseCode: string;
  courseName: string;
  programId?: string;
  sectionCode: string;
  professorId: string;
  professorName: string | null;
  termStartDate: string | null;
  termEndDate: string | null;
}

export interface CanonicalEnrollment {
  classSectionId: string;
  studentId: string;
  status: 'active' | 'withdrawn' | 'completed';
  userId?: string;
  email?: string;
}

export interface CanonicalData {
  institutionId: string;
  sections: CanonicalSection[];
  enrollments: CanonicalEnrollment[];
  classrooms: ClassroomInfo[];
  classroomsError: string | null;
}

export async function loadCanonical(
  institutionId: string,
  repo: AcademicRepository,
  classrooms: ClassroomDirectory | undefined,
): Promise<CanonicalData> {
  const snap = await repo.snapshot(institutionId);
  const byId = <T extends { id: string }>(m: Map<string, T>): Map<string, T> =>
    new Map([...m.values()].map((v) => [v.id, v]));
  const courses = byId(snap.courses);
  const professors = byId(snap.professors);
  const students = byId(snap.students);
  const terms = byId(snap.terms);
  const sections: CanonicalSection[] = [...snap.classSections.values()].map((s) => {
    const course = courses.get(s.courseId);
    const term = terms.get(s.academicTermId);
    return {
      classSectionId: s.id,
      institutionId,
      courseId: s.courseId,
      courseCode: course?.code ?? '',
      courseName: course?.name ?? '',
      sectionCode: s.sectionCode,
      professorId: s.professorId,
      professorName: professors.get(s.professorId)?.name ?? null,
      termStartDate: term?.startDate ?? null,
      termEndDate: term?.endDate ?? null,
    };
  });
  const enrollments: CanonicalEnrollment[] = [...snap.enrollments.values()].map((e) => {
    const email = students.get(e.studentId)?.email;
    return {
      classSectionId: e.classSectionId,
      studentId: e.studentId,
      status: e.status,
      ...(email ? { email } : {}),
    };
  });
  let rooms: ClassroomInfo[] = [];
  let classroomsError: string | null = null;
  if (classrooms) {
    try {
      rooms = await classrooms.listClassrooms(institutionId);
    } catch (err) {
      classroomsError = err instanceof Error ? err.message : String(err);
    }
  }
  return { institutionId, sections, enrollments, classrooms: rooms, classroomsError };
}

// ---------------------------------------------------------------- per-target mapping

export interface SyncRequest {
  path: string;
  body: unknown;
}

const chunk = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** Enrollment batches that never split a section (targets with `replace` semantics are per section). */
function bySectionBatches(
  enrollments: readonly CanonicalEnrollment[],
  sections: readonly CanonicalSection[],
  max: number,
): CanonicalEnrollment[][] {
  const groups = new Map<string, CanonicalEnrollment[]>(
    sections.map((s) => [s.classSectionId, []]),
  );
  for (const e of enrollments)
    groups.set(e.classSectionId, [...(groups.get(e.classSectionId) ?? []), e]);
  const batches: CanonicalEnrollment[][] = [];
  let current: CanonicalEnrollment[] = [];
  for (const group of groups.values()) {
    if (current.length > 0 && current.length + group.length > max) {
      batches.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const activeStudentsBySection = (d: CanonicalData): Map<string, string[]> => {
  const m = new Map<string, string[]>(d.sections.map((s) => [s.classSectionId, []]));
  for (const e of d.enrollments)
    if (e.status === 'active') m.get(e.classSectionId)?.push(e.studentId);
  return m;
};

const defined = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''),
  ) as Partial<T>;

/**
 * Maps the canonical data to the REAL request bodies of each target:
 * - identity: POST /v1/sync/sections {institutionId, sections:[{classSectionId, professorId, courseId}]},
 *   POST /v1/sync/enrollments {institutionId, mode:'replace', enrollments:[{studentId, classSectionId, status}]}
 * - calendar: POST /v1/sections {sections:[{classSectionId, institutionId, courseId, professorId, courseName, sectionCode}]},
 *   POST /v1/enrollments/bulk {classSectionId, studentIds, mode:'replace'} per section
 * - notifications: POST /v1/sync/enrollments (identity body + email)
 * - analytics: POST /v1/sync/sections, /v1/sync/enrollments (per section), /v1/sync/classrooms
 */
export function requestsFor(kind: TargetKind, d: CanonicalData): SyncRequest[] {
  const inst = d.institutionId;
  const replaceEnrollments = (withEmail: boolean): SyncRequest[] =>
    bySectionBatches(d.enrollments, d.sections, 10_000).map((batch) => ({
      path: '/v1/sync/enrollments',
      body: {
        institutionId: inst,
        mode: 'replace',
        enrollments: batch.map((e) => ({
          studentId: e.studentId,
          classSectionId: e.classSectionId,
          status: e.status,
          ...(withEmail && e.email ? { email: e.email } : {}),
        })),
      },
    }));
  const perSection = (path: string): SyncRequest[] =>
    [...activeStudentsBySection(d)].map(([classSectionId, studentIds]) => ({
      path,
      body: { classSectionId, studentIds, mode: 'replace' },
    }));

  switch (kind) {
    case 'identity':
      return [
        ...chunk(d.sections, 5000).map((c) => ({
          path: '/v1/sync/sections',
          body: {
            institutionId: inst,
            sections: c.map((s) => ({
              classSectionId: s.classSectionId,
              professorId: s.professorId,
              courseId: s.courseId,
            })),
          },
        })),
        ...replaceEnrollments(false),
      ];
    case 'notifications':
      return replaceEnrollments(true);
    case 'calendar':
      return [
        ...chunk(d.sections, 5000).map((c) => ({
          path: '/v1/sections',
          body: {
            sections: c.map((s) =>
              defined({
                classSectionId: s.classSectionId,
                institutionId: inst,
                courseId: s.courseId,
                professorId: s.professorId,
                courseName: s.courseName,
                sectionCode: s.sectionCode,
              }),
            ),
          },
        })),
        ...perSection('/v1/enrollments/bulk'),
      ];
    case 'analytics':
      return [
        ...chunk(d.sections, 5000).map((c) => ({
          path: '/v1/sync/sections',
          body: {
            sections: c.map((s) =>
              defined({
                classSectionId: s.classSectionId,
                institutionId: inst,
                courseId: s.courseId,
                courseCode: s.courseCode,
                courseName: s.courseName,
                programId: s.programId,
                professorId: s.professorId,
                professorName: s.professorName,
                sectionCode: s.sectionCode,
                termStartDate: s.termStartDate,
                termEndDate: s.termEndDate,
              }),
            ),
          },
        })),
        ...perSection('/v1/sync/enrollments'),
        ...chunk(d.classrooms, 5000).map((c) => ({
          path: '/v1/sync/classrooms',
          body: {
            classrooms: c.map((r) =>
              defined({
                classroomId: r.classroomId,
                institutionId: r.institutionId,
                campusId: r.campusId,
                campusName: r.campusName,
                name: r.name,
              }),
            ),
          },
        })),
      ];
  }
}

// ---------------------------------------------------------------- push with retries and status

export interface TargetStatus {
  name: string;
  kind: TargetKind;
  url: string;
  state: 'never' | 'ok' | 'failed';
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastPush: {
    institutionId: string;
    requests: number;
    sections: number;
    enrollments: number;
    classrooms: number;
  } | null;
  /** Institutions whose last push to this target failed; retried in the background. */
  pendingInstitutions: string[];
}

export interface PushResult {
  target: string;
  ok: boolean;
  requests: number;
  error?: string;
}

export interface SyncOptions {
  internalToken?: string;
  attempts?: number;
  backoffMs?: number;
  timeoutMs?: number;
  /** Background retry of failed pushes; 0 disables. */
  retryIntervalMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
  onError?: (target: string, err: string) => void;
}

export class SyncService {
  private readonly status = new Map<string, TargetStatus>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly targets: readonly SyncTarget[],
    private readonly repo: AcademicRepository,
    private readonly classrooms: ClassroomDirectory | undefined,
    private readonly options: SyncOptions = {},
  ) {
    for (const t of targets) {
      this.status.set(t.name, {
        name: t.name,
        kind: t.kind,
        url: t.url,
        state: 'never',
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastError: null,
        consecutiveFailures: 0,
        lastPush: null,
        pendingInstitutions: [],
      });
    }
    const interval = options.retryIntervalMs ?? 60_000;
    if (interval > 0 && targets.length > 0) {
      this.timer = setInterval(() => void this.retryPending(), interval);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Queues a push (pushes run one at a time, in order). */
  schedule(institutionId: string, targetNames?: readonly string[]): Promise<PushResult[]> {
    const run = this.queue.then(() => this.push(institutionId, targetNames));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Resolves once every queued push has finished. */
  async idle(): Promise<void> {
    await this.queue;
  }

  snapshot(): TargetStatus[] {
    return [...this.status.values()].map((s) => ({
      ...s,
      pendingInstitutions: [...s.pendingInstitutions],
    }));
  }

  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private async retryPending(): Promise<void> {
    for (const s of this.status.values()) {
      for (const inst of [...s.pendingInstitutions]) await this.schedule(inst, [s.name]);
    }
  }

  private async push(
    institutionId: string,
    targetNames?: readonly string[],
  ): Promise<PushResult[]> {
    const targets = this.targets.filter((t) => !targetNames || targetNames.includes(t.name));
    if (targets.length === 0) return [];
    const data = await loadCanonical(institutionId, this.repo, this.classrooms);
    return Promise.all(targets.map((t) => this.pushTarget(t, data)));
  }

  private async pushTarget(t: SyncTarget, data: CanonicalData): Promise<PushResult> {
    const st = this.status.get(t.name);
    if (!st) return { target: t.name, ok: false, requests: 0, error: 'unknown target' };
    st.lastAttemptAt = this.now();
    const requests = requestsFor(t.kind, data);
    try {
      if (t.kind === 'analytics' && data.classroomsError)
        throw new Error(`classrooms unavailable: ${data.classroomsError}`);
      for (const r of requests) await this.send(t, r);
      st.state = 'ok';
      st.lastSuccessAt = this.now();
      st.lastError = null;
      st.consecutiveFailures = 0;
      st.pendingInstitutions = st.pendingInstitutions.filter((i) => i !== data.institutionId);
      st.lastPush = {
        institutionId: data.institutionId,
        requests: requests.length,
        sections: data.sections.length,
        enrollments: data.enrollments.length,
        classrooms: data.classrooms.length,
      };
      return { target: t.name, ok: true, requests: requests.length };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      st.state = 'failed';
      st.lastError = message;
      st.consecutiveFailures++;
      if (!st.pendingInstitutions.includes(data.institutionId))
        st.pendingInstitutions.push(data.institutionId);
      this.options.onError?.(t.name, message);
      return { target: t.name, ok: false, requests: requests.length, error: message };
    }
  }

  private async send(t: SyncTarget, r: SyncRequest): Promise<void> {
    const doFetch = this.options.fetch ?? globalThis.fetch;
    const attempts = this.options.attempts ?? 3;
    let last = '';
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await doFetch(`${t.url}${r.path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.options.internalToken
              ? { 'x-internal-token': this.options.internalToken }
              : {}),
          },
          body: JSON.stringify(r.body),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        });
        if (res.ok) return;
        last = `${r.path} returned ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
          break;
      } catch (err) {
        last = `${r.path}: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (i < attempts - 1)
        await new Promise((resolve) =>
          setTimeout(resolve, (this.options.backoffMs ?? 500) * 2 ** i),
        );
    }
    throw new Error(last);
  }
}
