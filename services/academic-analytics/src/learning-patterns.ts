/**
 * Learning pattern analytics (Phase 6.7). Aggregates only: every figure derived from student behaviour
 * is published only when it covers at least MIN_COHORT distinct students. Student ids are used in
 * memory for distinct counts and never leave this module.
 */
import type { AuditEvent, ScheduledClass } from './clients.js';
import { ASSESSMENT_TYPES } from './assessments.js';
import type { Directory, Section } from './directory.js';
import type { UpstreamClients } from './fakes.js';
import { addDays, eachDate, median, MIN_COHORT, round } from './stats.js';

export const LEARNING_ACTIONS = {
  view: 'lecture.viewed',
  search: 'lecture.searched',
  question: 'lecture.assistant_question',
} as const;

const CURVE_DAYS = 14;
const REVISIT_WINDOW_DAYS = 7;
const PRE_ASSESSMENT_DAYS = 3;
const TOP_TOPICS = 10;
const TOP_TERMS = 20;

interface Signal {
  student: string;
  classSectionId: string;
  scheduledClassId: string | null;
  at: string;
  date: string;
  resultCount: number | null;
  zeroResultTerms: string[];
}

export interface Signals {
  views: Signal[];
  searches: Signal[];
  questions: Signal[];
}

interface Assessment {
  id: string;
  type: string;
  title: string;
  date: string;
  classSectionId: string;
}

export interface PatternInputs {
  signals: Signals;
  classes: Map<string, ScheduledClass>;
  assessments: Assessment[];
  enrolled: Map<string, number>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function toSignal(e: AuditEvent): Signal | null {
  const section = str(e.metadata?.['classSectionId']);
  if (e.actorType !== 'student' || !e.actorId || !section) return null;
  const terms = e.metadata?.['zeroResultTerms'];
  const count = e.metadata?.['resultCount'];
  return {
    student: e.actorId,
    classSectionId: section,
    scheduledClassId: str(e.metadata?.['scheduledClassId']),
    at: e.occurredAt,
    date: e.occurredAt.slice(0, 10),
    resultCount: typeof count === 'number' ? count : null,
    zeroResultTerms: Array.isArray(terms)
      ? terms.filter((t): t is string => typeof t === 'string').slice(0, 5)
      : [],
  };
}

/** Pulls engagement events, classes, assessments and enrolment sizes once for an institution. */
export async function loadInputs(
  institutionId: string,
  sections: readonly Section[],
  from: string,
  to: string,
  directory: Directory,
  up: UpstreamClients,
): Promise<PatternInputs> {
  const ids = new Set(sections.map((s) => s.classSectionId));
  const range = [
    `${addDays(from, -CURVE_DAYS)}T00:00:00.000Z`,
    `${addDays(to, 1)}T00:00:00.000Z`,
  ] as const;
  const [views, searches, questions] = await Promise.all(
    [LEARNING_ACTIONS.view, LEARNING_ACTIONS.search, LEARNING_ACTIONS.question].map(
      async (action) =>
        (await up.audit.listEvents(institutionId, action, range[0], range[1]))
          .map(toSignal)
          .filter((s): s is Signal => s !== null && ids.has(s.classSectionId)),
    ),
  );
  const classLists = await Promise.all(
    sections.map((s) =>
      up.academic.listScheduledClasses(
        s.classSectionId,
        `${addDays(from, -CURVE_DAYS)}T00:00:00.000Z`,
        `${addDays(to, 1)}T00:00:00.000Z`,
      ),
    ),
  );
  const classes = new Map(
    classLists
      .flat()
      .filter((c) => c.status !== 'cancelled')
      .map((c) => [c.id, c]),
  );
  const assessments = (
    await up.calendar.listEvents(institutionId, from, addDays(to, REVISIT_WINDOW_DAYS))
  )
    .filter(
      (e) => ids.has(e.classSectionId) && ASSESSMENT_TYPES.has(e.type) && e.status !== 'cancelled',
    )
    .map((e) => ({
      id: e.id,
      type: e.type,
      title: e.title,
      date: e.eventDate,
      classSectionId: e.classSectionId,
    }));
  const enrolled = new Map<string, number>();
  for (const s of sections)
    enrolled.set(s.classSectionId, (await directory.students(s.classSectionId)).size);
  return {
    signals: { views: views ?? [], searches: searches ?? [], questions: questions ?? [] },
    classes,
    assessments,
    enrolled,
  };
}

const distinct = (xs: readonly Signal[]): number => new Set(xs.map((x) => x.student)).size;
const gated = <T extends Record<string, number | null>>(
  students: number,
  metrics: T,
): T & { students: number | null; suppressed: boolean } =>
  students >= MIN_COHORT
    ? { ...metrics, students, suppressed: false }
    : ({
        ...Object.fromEntries(Object.keys(metrics).map((k) => [k, null])),
        students: null,
        suppressed: true,
      } as T & {
        students: null;
        suppressed: true;
      });

const daysBetween = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 86_400_000;

/** Views after each class, by days elapsed since the class ended. */
function engagementCurve(
  views: readonly Signal[],
  classes: Map<string, ScheduledClass>,
  from: string,
  to: string,
) {
  const attributed = views
    .map((v) => ({ v, c: v.scheduledClassId ? classes.get(v.scheduledClassId) : undefined }))
    .filter(
      (x): x is { v: Signal; c: ScheduledClass } =>
        x.c !== undefined && x.c.localDate >= from && x.c.localDate <= to,
    );
  const buckets = Array.from({ length: CURVE_DAYS + 1 }, (_, day) => {
    const inBucket = attributed.filter(({ v, c }) => {
      const d = Math.max(0, Math.floor(daysBetween(c.endsAt, v.at)));
      return day === CURVE_DAYS ? d >= CURVE_DAYS : d === day;
    });
    return {
      daysAfterClass: day === CURVE_DAYS ? `${CURVE_DAYS}+` : String(day),
      ...gated(distinct(inBucket.map((x) => x.v)), { views: inBucket.length }),
    };
  });
  // Days from class end to a student's first view of it (per student-class pair), aggregated.
  const firstView = new Map<string, number>();
  for (const { v, c } of attributed) {
    const key = `${v.student}|${c.id}`;
    const d = Math.max(0, daysBetween(c.endsAt, v.at));
    firstView.set(key, Math.min(firstView.get(key) ?? Infinity, d));
  }
  const students = distinct(attributed.map((x) => x.v));
  const firstDays = [...firstView.values()];
  return {
    buckets,
    summary: gated(students, {
      views: attributed.length,
      medianDaysToFirstView: firstDays.length > 0 ? round(median(firstDays) ?? 0, 1) : null,
      viewedWithin2DaysShare:
        firstDays.length > 0
          ? round(firstDays.filter((d) => d <= 2).length / firstDays.length)
          : null,
    }),
  };
}

/** Share of enrolled students who revisit lectures in the 7 days before an assessment vs. the week before. */
function revisitBeforeAssessments(
  views: readonly Signal[],
  assessments: readonly Assessment[],
  enrolled: Map<string, number>,
  from: string,
  to: string,
) {
  const rows = assessments
    .filter((a) => a.date >= from && a.date <= addDays(to, REVISIT_WINDOW_DAYS))
    .map((a) => {
      const inWindow = (start: string, end: string): Signal[] =>
        views.filter(
          (v) => v.classSectionId === a.classSectionId && v.date >= start && v.date <= end,
        );
      const revisit = inWindow(addDays(a.date, -REVISIT_WINDOW_DAYS), addDays(a.date, -1));
      const baseline = inWindow(
        addDays(a.date, -2 * REVISIT_WINDOW_DAYS),
        addDays(a.date, -REVISIT_WINDOW_DAYS - 1),
      );
      const size = enrolled.get(a.classSectionId) ?? 0;
      const revisitStudents = distinct(revisit);
      const baselineStudents = distinct(baseline);
      const publish = size >= MIN_COHORT && revisitStudents >= MIN_COHORT;
      const revisitRate = publish ? round(revisitStudents / size) : null;
      // The baseline is itself a student aggregate: below the cohort it is withheld (and so is the lift).
      const baselineRate =
        publish && baselineStudents >= MIN_COHORT ? round(baselineStudents / size) : null;
      return {
        assessmentId: a.id,
        type: a.type,
        title: a.title,
        date: a.date,
        classSectionId: a.classSectionId,
        revisitRate,
        baselineRate,
        lift:
          revisitRate !== null && baselineRate !== null ? round(revisitRate - baselineRate) : null,
        suppressed: !publish,
      };
    })
    .sort((x, y) => (x.date < y.date ? -1 : 1));
  const published = rows.filter((r) => !r.suppressed);
  const mean = (xs: (number | null)[]): number | null => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length > 0 ? round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  return {
    assessments: rows,
    summary: {
      assessments: rows.length,
      published: published.length,
      meanRevisitRate: mean(published.map((r) => r.revisitRate)),
      meanLift: mean(published.map((r) => r.lift)),
    },
  };
}

/** Lectures with the highest assistant-question density (questions per enrolled student). */
async function difficultTopics(
  questions: readonly Signal[],
  classes: Map<string, ScheduledClass>,
  enrolled: Map<string, number>,
  from: string,
  to: string,
  up: UpstreamClients,
) {
  const byClass = new Map<string, Signal[]>();
  let unattributed = 0;
  for (const q of questions) {
    const c = q.scheduledClassId ? classes.get(q.scheduledClassId) : undefined;
    if (!c || c.localDate < from || c.localDate > to) {
      unattributed++;
      continue;
    }
    byClass.set(c.id, [...(byClass.get(c.id) ?? []), q]);
  }
  const ranked = [...byClass.entries()]
    .map(([classId, qs]) => {
      const c = classes.get(classId);
      const size = c ? (enrolled.get(c.classSectionId) ?? 0) : 0;
      return {
        classId,
        c,
        questions: qs.length,
        askers: distinct(qs),
        density: size > 0 ? qs.length / size : 0,
      };
    })
    // Cohort rule: a lecture is only listed when at least MIN_COHORT distinct students asked about it.
    .filter((r) => r.askers >= MIN_COHORT && r.c !== undefined)
    .sort((a, b) => b.density - a.density || b.questions - a.questions)
    .slice(0, TOP_TOPICS);
  const topics = await Promise.all(
    ranked.map(async (r) => {
      const lecture = await up.lectures.getLecture(r.classId);
      return {
        scheduledClassId: r.classId,
        classSectionId: r.c?.classSectionId ?? null,
        date: r.c?.localDate ?? null,
        lectureTitle: lecture?.title ?? null,
        topics: (lecture?.topics ?? []).slice(0, 3).map((t) => t.title),
        questions: r.questions,
        students: r.askers,
        questionsPerEnrolledStudent: round(r.density),
      };
    }),
  );
  return {
    topics,
    summary: gated(distinct(questions), {
      questions: questions.length,
      unattributedQuestions: unattributed,
    }),
  };
}

/** Normalised search terms that returned nothing, published only when ≥ MIN_COHORT students searched them. */
function searchesWithoutResults(searches: readonly Signal[]) {
  const zero = searches.filter((s) => s.resultCount === 0);
  const byTerm = new Map<string, Signal[]>();
  for (const s of zero)
    for (const t of new Set(s.zeroResultTerms)) byTerm.set(t, [...(byTerm.get(t) ?? []), s]);
  const terms = [...byTerm.entries()]
    .map(([term, list]) => ({ term, searches: list.length, students: distinct(list) }))
    .filter((t) => t.students >= MIN_COHORT)
    .sort(
      (a, b) => b.students - a.students || b.searches - a.searches || a.term.localeCompare(b.term),
    )
    .slice(0, TOP_TERMS);
  return {
    terms,
    summary: gated(distinct(searches), {
      searches: searches.length,
      zeroResultSearches: zero.length,
      zeroResultRate: searches.length > 0 ? round(zero.length / searches.length) : null,
    }),
  };
}

/** Daily engagement next to the assessment calendar. */
function engagementVsAssessments(
  signals: Signals,
  assessments: readonly Assessment[],
  from: string,
  to: string,
) {
  const all = [...signals.views, ...signals.searches, ...signals.questions];
  const assessmentDays = new Map<string, number>();
  for (const a of assessments) assessmentDays.set(a.date, (assessmentDays.get(a.date) ?? 0) + 1);
  const countByDate = (xs: readonly Signal[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x.date, (m.get(x.date) ?? 0) + 1);
    return m;
  };
  const views = countByDate(signals.views);
  const searches = countByDate(signals.searches);
  const questions = countByDate(signals.questions);
  const studentsByDate = new Map<string, Set<string>>();
  for (const x of all)
    studentsByDate.set(x.date, (studentsByDate.get(x.date) ?? new Set()).add(x.student));
  const days = [...eachDate(from, to)].map((date) => ({
    date,
    assessments: assessmentDays.get(date) ?? 0,
    ...gated(studentsByDate.get(date)?.size ?? 0, {
      views: views.get(date) ?? 0,
      searches: searches.get(date) ?? 0,
      assistantQuestions: questions.get(date) ?? 0,
    }),
  }));
  const preDates = new Set(
    [...assessmentDays.keys()].flatMap((d) =>
      Array.from({ length: PRE_ASSESSMENT_DAYS }, (_, i) => addDays(d, -(i + 1))),
    ),
  );
  const inRange = (s: Signal): boolean => s.date >= from && s.date <= to;
  const pre = all.filter((s) => inRange(s) && preDates.has(s.date));
  const other = all.filter(
    (s) => inRange(s) && !preDates.has(s.date) && !assessmentDays.has(s.date),
  );
  const preDayCount = [...eachDate(from, to)].filter((d) => preDates.has(d)).length;
  const otherDayCount = [...eachDate(from, to)].filter(
    (d) => !preDates.has(d) && !assessmentDays.has(d),
  ).length;
  const preAvg = preDayCount > 0 ? pre.length / preDayCount : null;
  const otherAvg = otherDayCount > 0 ? other.length / otherDayCount : null;
  return {
    days,
    summary: {
      preAssessmentDays: PRE_ASSESSMENT_DAYS,
      ...gated(Math.min(distinct(pre), distinct(other)), {
        avgDailyActivityBeforeAssessments: preAvg === null ? null : round(preAvg, 2),
        avgDailyActivityOtherDays: otherAvg === null ? null : round(otherAvg, 2),
        ratio: preAvg !== null && otherAvg ? round(preAvg / otherAvg, 2) : null,
      }),
    },
  };
}

export async function learningPatterns(
  inputs: PatternInputs,
  sectionIds: ReadonlySet<string>,
  from: string,
  to: string,
  up: UpstreamClients,
) {
  const only = (xs: readonly Signal[]): Signal[] =>
    xs.filter((s) => sectionIds.has(s.classSectionId));
  const signals: Signals = {
    views: only(inputs.signals.views),
    searches: only(inputs.signals.searches),
    questions: only(inputs.signals.questions),
  };
  const assessments = inputs.assessments.filter((a) => sectionIds.has(a.classSectionId));
  const classes = new Map([...inputs.classes].filter(([, c]) => sectionIds.has(c.classSectionId)));
  const inRange = (s: Signal): boolean => s.date >= from && s.date <= to;
  const active = distinct(
    [...signals.views, ...signals.searches, ...signals.questions].filter(inRange),
  );
  return {
    activeStudents:
      active >= MIN_COHORT
        ? { count: active, suppressed: false }
        : { count: null, suppressed: true },
    engagementCurve: engagementCurve(signals.views, classes, from, to),
    revisitBeforeAssessments: revisitBeforeAssessments(
      signals.views,
      assessments,
      inputs.enrolled,
      from,
      to,
    ),
    difficultTopics: await difficultTopics(
      signals.questions.filter(inRange),
      classes,
      inputs.enrolled,
      from,
      to,
      up,
    ),
    searchesWithoutResults: searchesWithoutResults(signals.searches.filter(inRange)),
    engagementVsAssessments: engagementVsAssessments(signals, assessments, from, to),
  };
}
