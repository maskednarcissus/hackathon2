import type { AuditEvent, ExtractedEvent } from './clients.js';
import type { Directory, Section } from './directory.js';
import type { UpstreamClients } from './fakes.js';
import { addDays } from './stats.js';

/** One scheduled class with everything the pipeline produced for it. The unit stored in snapshots. */
export interface ClassFact {
  scheduledClassId: string;
  institutionId: string;
  classSectionId: string;
  courseId: string;
  professorId: string;
  classroomId: string;
  campusId: string | null;
  localDate: string;
  startsAt: string;
  endsAt: string;
  cancelled: boolean;
  /** Class has ended (only due classes count as scheduled in coverage / adoption). */
  due: boolean;
  captured: boolean;
  recordingSessionIds: string[];
  transcribed: boolean;
  transcriptionFailed: boolean;
  failureReasons: string[];
  meanConfidence: number | null;
  correctedSegments: number;
  transcriptCreatedAt: string | null;
  structured: boolean;
  summaryCreatedAt: string | null;
  eventsExtracted: number;
  eventsReviewed: number;
  eventEdits: number;
  eventRejections: number;
  reviewLatenciesMinutes: number[];
  firstEventCreatedAt: string | null;
}

const REVIEWED_STATUSES = new Set(['confirmed', 'published', 'rejected']);
const HUMAN_SOURCES = new Set(['professor', 'admin']);

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const minutesBetween = (a: string, b: string): number =>
  Math.round((Date.parse(b) - Date.parse(a)) / 60_000);

function eventFacts(
  events: readonly ExtractedEvent[],
): Pick<
  ClassFact,
  | 'eventsExtracted'
  | 'eventsReviewed'
  | 'eventEdits'
  | 'eventRejections'
  | 'reviewLatenciesMinutes'
  | 'firstEventCreatedAt'
> {
  const primary = events.filter((e) => !e.duplicateOf);
  let reviewed = 0;
  let edits = 0;
  let rejections = 0;
  const latencies: number[] = [];
  for (const e of primary) {
    const human = e.changeHistory
      .filter((c) => HUMAN_SOURCES.has(c.source))
      .sort((a, b) => (a.changedAt < b.changedAt ? -1 : 1));
    if (REVIEWED_STATUSES.has(e.confirmationStatus) || human.length > 0) reviewed++;
    if (e.confirmationStatus === 'rejected') rejections++;
    edits += human.filter(
      (c) => c.changeType !== 'status_change' && c.field !== 'confirmationStatus',
    ).length;
    const first = human[0];
    if (first) latencies.push(Math.max(0, minutesBetween(e.createdAt, first.changedAt)));
  }
  const firstCreated = primary.map((e) => e.createdAt).sort()[0] ?? null;
  return {
    eventsExtracted: primary.length,
    eventsReviewed: reviewed,
    eventEdits: edits,
    eventRejections: rejections,
    reviewLatenciesMinutes: latencies,
    firstEventCreatedAt: firstCreated,
  };
}

/**
 * Collects class facts for an institution's classes whose local date is in [from, to] by pulling
 * every upstream through its client. `now` decides which classes are due.
 */
export async function collectClassFacts(
  institutionId: string,
  from: string,
  to: string,
  now: Date,
  directory: Directory,
  up: UpstreamClients,
  onlySections?: readonly Section[],
): Promise<ClassFact[]> {
  const sections = onlySections ?? (await directory.sections(institutionId));
  // Wide UTC window around the local dates; exact filtering on localDate below.
  const windowFrom = `${addDays(from, -1)}T00:00:00.000Z`;
  const windowTo = `${addDays(to, 2)}T00:00:00.000Z`;
  // Recordings and processing may complete days after the class.
  const auditTo = `${addDays(to, 15)}T00:00:00.000Z`;

  const [identified, uploaded, completed, failed] = await Promise.all(
    [
      'recording.class_identified',
      'recording.uploaded',
      'transcription.completed',
      'transcription.failed',
    ].map((action) => up.audit.listEvents(institutionId, action, windowFrom, auditTo)),
  );

  const recordingsByClass = new Map<string, Set<string>>();
  const link = (classId: string | null, rec: string | null): void => {
    if (!classId || !rec) return;
    let set = recordingsByClass.get(classId);
    if (!set) recordingsByClass.set(classId, (set = new Set()));
    set.add(rec);
  };
  const recordingOf = (e: AuditEvent): string | null =>
    str(e.metadata?.['recordingSessionId']) ?? e.resourceId;
  for (const e of identified ?? []) {
    if (e.metadata?.['status'] === 'matched')
      link(str(e.metadata['scheduledClassId']), recordingOf(e));
  }
  for (const e of uploaded ?? []) link(str(e.metadata?.['scheduledClassId']), recordingOf(e));
  const completedRecs = new Set(
    (completed ?? []).map(recordingOf).filter((r): r is string => r !== null),
  );
  const failuresByRec = new Map<string, string[]>();
  for (const e of failed ?? []) {
    const rec = recordingOf(e);
    if (rec)
      failuresByRec.set(rec, [
        ...(failuresByRec.get(rec) ?? []),
        str(e.metadata?.['reason']) ?? 'unknown',
      ]);
  }

  const perSection = await Promise.all(
    sections.map(async (section) => {
      const [classes, events] = await Promise.all([
        up.academic.listScheduledClasses(section.classSectionId, windowFrom, windowTo),
        up.events.listForSection(section.classSectionId),
      ]);
      const eventsByClass = new Map<string, ExtractedEvent[]>();
      for (const e of events)
        eventsByClass.set(e.scheduledClassId, [
          ...(eventsByClass.get(e.scheduledClassId) ?? []),
          e,
        ]);

      return Promise.all(
        classes
          .filter((c) => c.localDate >= from && c.localDate <= to)
          .map(async (c): Promise<ClassFact> => {
            const recs = [...(recordingsByClass.get(c.id) ?? [])].sort();
            const transcriptLists = await Promise.all(
              recs.map((r) => up.transcripts.listByRecording(r)),
            );
            const transcripts = transcriptLists
              .flat()
              .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
            const latest = transcripts[0];
            const firstTranscript = transcripts[transcripts.length - 1];
            const lecture = latest ? await up.lectures.getLecture(c.id) : null;
            const reasons = recs.flatMap((r) => failuresByRec.get(r) ?? []);
            const classroom = await directory.classroom(c.classroomId);
            return {
              scheduledClassId: c.id,
              institutionId,
              classSectionId: c.classSectionId,
              courseId: c.courseId,
              professorId: c.professorId,
              classroomId: c.classroomId,
              campusId: classroom?.campusId ?? null,
              localDate: c.localDate,
              startsAt: c.startsAt,
              endsAt: c.endsAt,
              cancelled: c.status === 'cancelled',
              due: Date.parse(c.endsAt) <= now.getTime(),
              captured: recs.length > 0,
              recordingSessionIds: recs,
              transcribed: transcripts.length > 0 || recs.some((r) => completedRecs.has(r)),
              transcriptionFailed: transcripts.length === 0 && reasons.length > 0,
              failureReasons: transcripts.length === 0 ? reasons : [],
              meanConfidence: latest?.stats.averageConfidence ?? null,
              correctedSegments: latest?.stats.correctedSegmentCount ?? 0,
              transcriptCreatedAt: firstTranscript?.createdAt ?? null,
              structured: lecture !== null,
              summaryCreatedAt: lecture?.createdAt ?? null,
              ...eventFacts(eventsByClass.get(c.id) ?? []),
            };
          }),
      );
    }),
  );
  return perSection
    .flat()
    .sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0));
}
