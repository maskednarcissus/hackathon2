import type { AuditEvent } from './clients.js';
import type { Directory, Section } from './directory.js';
import type { ClassFact } from './facts.js';
import type { UpstreamClients } from './fakes.js';
import { addDays, cohort, countOrSuppressed, median, ratio, type Cohort } from './stats.js';

/** Student interaction audit actions (open `lecture.*` namespace) emitted by student-web / lecture-intelligence. */
export const ENGAGEMENT_ACTIONS = {
  views: 'lecture.viewed',
  searches: 'lecture.searched',
  assistantQuestions: 'lecture.assistant_question',
} as const;

interface Counters {
  classesScheduled: number;
  classesCancelled: number;
  captured: number;
  transcribed: number;
  structured: number;
  eventsExtracted: number;
  eventsReviewed: number;
  transcriptCorrections: number;
  eventEdits: number;
  latencies: number[];
}

const empty = (): Counters => ({
  classesScheduled: 0,
  classesCancelled: 0,
  captured: 0,
  transcribed: 0,
  structured: 0,
  eventsExtracted: 0,
  eventsReviewed: 0,
  transcriptCorrections: 0,
  eventEdits: 0,
  latencies: [],
});

function add(c: Counters, f: ClassFact): void {
  if (f.cancelled) {
    c.classesCancelled++;
    return;
  }
  if (!f.due) return;
  c.classesScheduled++;
  if (f.captured) c.captured++;
  if (f.transcribed) c.transcribed++;
  if (f.structured) c.structured++;
  c.eventsExtracted += f.eventsExtracted;
  c.eventsReviewed += f.eventsReviewed;
  c.transcriptCorrections += f.correctedSegments;
  c.eventEdits += f.eventEdits;
  c.latencies.push(...f.reviewLatenciesMinutes);
}

function present(c: Counters): Record<string, number | null> {
  return {
    classesScheduled: c.classesScheduled,
    classesCancelled: c.classesCancelled,
    classesCaptured: c.captured,
    classesTranscribed: c.transcribed,
    classesStructured: c.structured,
    captureRate: ratio(c.captured, c.classesScheduled),
    eventsExtracted: c.eventsExtracted,
    eventsReviewed: c.eventsReviewed,
    reviewRate: ratio(c.eventsReviewed, c.eventsExtracted),
    medianReviewLatencyMinutes: median(c.latencies),
    correctionsMade: c.transcriptCorrections + c.eventEdits,
    transcriptCorrections: c.transcriptCorrections,
    eventEdits: c.eventEdits,
  };
}

type Engagement = Cohort<{
  views: number;
  searches: number;
  assistantQuestions: number;
  activeStudents: number;
}>;

async function engagement(
  institutionId: string,
  from: string,
  to: string,
  up: UpstreamClients,
): Promise<
  Map<string, { counts: Record<keyof typeof ENGAGEMENT_ACTIONS, number>; students: Set<string> }>
> {
  const range = [`${from}T00:00:00.000Z`, `${addDays(to, 1)}T00:00:00.000Z`] as const;
  const lists = await Promise.all(
    Object.entries(ENGAGEMENT_ACTIONS).map(async ([key, action]) => ({
      key: key as keyof typeof ENGAGEMENT_ACTIONS,
      events: await up.audit.listEvents(institutionId, action, range[0], range[1]),
    })),
  );
  const bySection = new Map<
    string,
    { counts: Record<keyof typeof ENGAGEMENT_ACTIONS, number>; students: Set<string> }
  >();
  const sectionOf = (e: AuditEvent): string | null => {
    const v = e.metadata?.['classSectionId'];
    return typeof v === 'string' ? v : null;
  };
  for (const { key, events } of lists) {
    for (const e of events) {
      const section = sectionOf(e);
      if (!section || e.actorType !== 'student') continue;
      let entry = bySection.get(section);
      if (!entry)
        bySection.set(
          section,
          (entry = {
            counts: { views: 0, searches: 0, assistantQuestions: 0 },
            students: new Set(),
          }),
        );
      entry.counts[key]++;
      if (e.actorId) entry.students.add(e.actorId);
    }
  }
  return bySection;
}

/** Professor adoption & class analytics (4.5). */
export async function adoption(
  institutionId: string,
  from: string,
  to: string,
  facts: readonly ClassFact[],
  directory: Directory,
  up: UpstreamClients,
): Promise<{ professors: unknown[]; sections: unknown[]; totals: Record<string, number | null> }> {
  const sections = await directory.sections(institutionId);
  const sectionMap = new Map<string, Section>(sections.map((s) => [s.classSectionId, s]));
  const bySection = new Map<string, Counters>();
  const byProfessor = new Map<
    string,
    { counters: Counters; sections: Set<string>; name: string | null }
  >();
  const totals = empty();
  for (const f of facts) {
    const sc = bySection.get(f.classSectionId) ?? empty();
    bySection.set(f.classSectionId, sc);
    add(sc, f);
    const prof = byProfessor.get(f.professorId) ?? {
      counters: empty(),
      sections: new Set<string>(),
      name: sectionMap.get(f.classSectionId)?.professorName ?? null,
    };
    byProfessor.set(f.professorId, prof);
    add(prof.counters, f);
    prof.sections.add(f.classSectionId);
    add(totals, f);
  }
  const engagementBySection = await engagement(institutionId, from, to, up);

  const sectionRows = await Promise.all(
    [...bySection.entries()].map(async ([id, counters]) => {
      const s = sectionMap.get(id);
      const e = engagementBySection.get(id);
      const enrolled = (await directory.students(id)).size;
      const eng: Engagement = cohort(e?.students.size ?? 0, {
        views: e?.counts.views ?? 0,
        searches: e?.counts.searches ?? 0,
        assistantQuestions: e?.counts.assistantQuestions ?? 0,
        activeStudents: e?.students.size ?? 0,
      });
      return {
        classSectionId: id,
        courseId: s?.courseId ?? null,
        courseCode: s?.courseCode ?? null,
        courseName: s?.courseName ?? null,
        sectionCode: s?.sectionCode ?? null,
        professorId: s?.professorId ?? null,
        professorName: s?.professorName ?? null,
        enrolledStudents: countOrSuppressed(enrolled),
        ...present(counters),
        engagement: eng,
      };
    }),
  );
  const professorRows = [...byProfessor.entries()].map(([professorId, p]) => ({
    professorId,
    professorName: p.name,
    sections: [...p.sections],
    ...present(p.counters),
  }));
  const byName = (
    a: { courseCode?: string | null; professorName?: string | null },
    b: typeof a,
  ): number =>
    (a.professorName ?? a.courseCode ?? '').localeCompare(
      b.professorName ?? b.courseCode ?? '',
      'pt-BR',
    );
  return {
    professors: professorRows.sort(byName),
    sections: sectionRows.sort((a, b) =>
      (a.courseCode ?? '').localeCompare(b.courseCode ?? '', 'pt-BR'),
    ),
    totals: present(totals),
  };
}
