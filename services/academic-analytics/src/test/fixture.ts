import { generateKeyPairSync, sign } from 'node:crypto';
import { buildApp } from '../app.js';
import type { ExtractedEvent, ScheduledClass } from '../clients.js';
import { InMemoryDirectory, type Directory } from '../directory.js';
import { FakeUpstreams } from '../fakes.js';
import { createAccessTokenVerifier } from '../jwt-verify.js';
import { InMemoryAnalyticsRepository, type AnalyticsRepository } from '../repository.js';

export const INST = '11111111-1111-4111-8111-111111111111';
export const OTHER_INST = '22222222-2222-4222-8222-222222222222';
export const CAMPUS = '33333333-3333-4333-8333-333333333333';
export const R1 = 'a1000000-0000-4000-8000-000000000001';
export const R2 = 'a2000000-0000-4000-8000-000000000002';
export const PROGRAM = 'b0000000-0000-4000-8000-000000000001';
export const C1 = 'c1000000-0000-4000-8000-000000000001';
export const C2 = 'c2000000-0000-4000-8000-000000000002';
export const C3 = 'c3000000-0000-4000-8000-000000000003';
export const S1 = 'd1000000-0000-4000-8000-000000000001';
export const S2 = 'd2000000-0000-4000-8000-000000000002';
export const S3 = 'd3000000-0000-4000-8000-000000000003';
export const PROF_A = 'e1000000-0000-4000-8000-000000000001';
export const PROF_B = 'e2000000-0000-4000-8000-000000000002';
export const INTERNAL = 'internal-secret-token-for-tests';
export const student = (n: number): string =>
  `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const sc = (section: string, date: string): string =>
  `${section.slice(0, 2)}${date.replace(/-/g, '').slice(2)}-0000-4000-8000-000000000000`;

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

export function token(role: string, inst = INST, sub = PROF_A): string {
  const now = Math.floor(Date.parse('2026-11-10T12:00:00Z') / 1000);
  const head = b64({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' });
  const body = b64({
    iss: 'ci-identity',
    aud: 'ci',
    sub,
    iat: now,
    exp: now + 900,
    jti: 'j',
    inst,
    role,
  });
  const signature = sign(null, Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

export const coordinator = { authorization: `Bearer ${token('coordinator')}` };
export const internal = { 'x-internal-token': INTERNAL };
/** Legacy form still accepted: the internal token as a bearer token. */
export const internalBearer = { authorization: `Bearer ${INTERNAL}` };

function klass(
  section: string,
  course: string,
  prof: string,
  room: string,
  date: string,
  status: ScheduledClass['status'] = 'scheduled',
): ScheduledClass {
  return {
    id: sc(section, date),
    institutionId: INST,
    classSectionId: section,
    courseId: course,
    professorId: prof,
    classroomId: room,
    localDate: date,
    timezone: 'America/Sao_Paulo',
    startsAt: `${date}T22:00:00.000Z`,
    endsAt: `${date}T23:40:00.000Z`,
    status,
  };
}

function extracted(id: string, overrides: Partial<ExtractedEvent>): ExtractedEvent {
  return {
    id,
    type: 'examination',
    title: 'Prova',
    institutionId: INST,
    courseId: C1,
    classSectionId: S1,
    scheduledClassId: sc(S1, '2026-11-02'),
    eventDate: '2026-11-20',
    eventTime: null,
    confirmationStatus: 'awaiting_professor',
    duplicateOf: null,
    calendarEventId: null,
    changeHistory: [],
    createdAt: '2026-11-03T00:40:00.000Z',
    ...overrides,
  };
}

const audit = (
  action: string,
  resourceId: string | null,
  metadata: Record<string, unknown>,
  occurredAt: string,
  actorType = 'system',
  actorId: string | null = null,
) => ({
  id: `${action}-${resourceId ?? ''}-${occurredAt}-${actorId ?? ''}`,
  tenantId: INST,
  actorId,
  actorType,
  action,
  resourceType: 'recording_session',
  resourceId,
  metadata,
  occurredAt,
});

export const REC1 = '90000000-0000-4000-8000-000000000001';
export const REC2 = '90000000-0000-4000-8000-000000000002';
export const REC3 = '90000000-0000-4000-8000-000000000003';

export async function setup(
  options: { authDisabled?: boolean; repository?: AnalyticsRepository; directory?: Directory } = {},
) {
  const fake = new FakeUpstreams();
  const directory = options.directory ?? new InMemoryDirectory();
  const repository = options.repository ?? new InMemoryAnalyticsRepository();
  const clock = { now: () => new Date('2026-11-10T12:00:00.000Z') };
  const app = buildApp({
    repository,
    directory,
    upstreams: fake.clients(),
    auth: {
      disabled: options.authDisabled ?? false,
      verifier: createAccessTokenVerifier({ getKey: () => publicKey, now: clock.now }),
      internalToken: INTERNAL,
    },
    clock,
  });

  const post = async (url: string, payload: unknown): Promise<void> => {
    const r = await app.inject({
      method: 'POST',
      url,
      headers: internal,
      payload: payload as Record<string, unknown>,
    });
    if (r.statusCode !== 200) throw new Error(`${url}: ${r.body}`);
  };
  const base = { institutionId: INST, termStartDate: '2026-11-02', termEndDate: '2026-12-18' };
  await post('/v1/sync/sections', {
    sections: [
      {
        ...base,
        classSectionId: S1,
        courseId: C1,
        courseCode: 'DIR101',
        courseName: 'Direito Constitucional',
        programId: PROGRAM,
        professorId: PROF_A,
        professorName: 'Ana Souza',
        sectionCode: 'A',
      },
      {
        ...base,
        classSectionId: S2,
        courseId: C2,
        courseCode: 'ECO201',
        courseName: 'Economia',
        programId: PROGRAM,
        professorId: PROF_B,
        professorName: 'Bruno Reis',
        sectionCode: 'A',
      },
      {
        ...base,
        classSectionId: S3,
        courseId: C3,
        courseCode: 'MED300',
        courseName: 'Anatomia',
        professorId: PROF_B,
        professorName: 'Bruno Reis',
        sectionCode: 'B',
      },
    ],
  });
  const range = (a: number, b: number): string[] =>
    Array.from({ length: b - a + 1 }, (_, i) => student(a + i));
  await post('/v1/sync/enrollments', { classSectionId: S1, studentIds: range(1, 8) });
  await post('/v1/sync/enrollments', { classSectionId: S2, studentIds: range(4, 10) });
  await post('/v1/sync/enrollments', { classSectionId: S3, studentIds: range(1, 3) });
  await post('/v1/sync/classrooms', {
    classrooms: [
      {
        classroomId: R1,
        institutionId: INST,
        campusId: CAMPUS,
        campusName: 'Campus Centro',
        name: 'Sala 101, Bloco A',
      },
      {
        classroomId: R2,
        institutionId: INST,
        campusId: CAMPUS,
        campusName: 'Campus Centro',
        name: 'Sala 202',
      },
    ],
  });

  fake.scheduledClasses = [
    klass(S1, C1, PROF_A, R1, '2026-11-02'),
    klass(S1, C1, PROF_A, R1, '2026-11-04'),
    klass(S1, C1, PROF_A, R1, '2026-11-06', 'cancelled'),
    klass(S1, C1, PROF_A, R1, '2026-11-09'),
    klass(S1, C1, PROF_A, R1, '2026-11-11'),
    klass(S2, C2, PROF_B, R2, '2026-11-03'),
    klass(S2, C2, PROF_B, R2, '2026-11-05'),
    klass(S3, C3, PROF_B, R2, '2026-11-04'),
  ];
  fake.auditEvents = [
    audit(
      'recording.class_identified',
      REC1,
      { recordingSessionId: REC1, status: 'matched', scheduledClassId: sc(S1, '2026-11-02') },
      '2026-11-03T00:00:00.000Z',
    ),
    audit(
      'recording.class_identified',
      REC2,
      { recordingSessionId: REC2, status: 'matched', scheduledClassId: sc(S1, '2026-11-04') },
      '2026-11-05T00:00:00.000Z',
    ),
    audit(
      'recording.class_identified',
      null,
      { status: 'ambiguous', scheduledClassId: sc(S1, '2026-11-09') },
      '2026-11-10T00:00:00.000Z',
    ),
    audit(
      'recording.uploaded',
      REC3,
      { scheduledClassId: sc(S2, '2026-11-03') },
      '2026-11-04T00:00:00.000Z',
    ),
    audit('transcription.completed', REC1, {}, '2026-11-03T00:30:00.000Z'),
    audit(
      'transcription.failed',
      REC3,
      { recordingSessionId: REC3, reason: 'provider_error' },
      '2026-11-04T01:00:00.000Z',
    ),
    ...range(1, 6).map((s) =>
      audit(
        'lecture.viewed',
        null,
        { classSectionId: S1 },
        '2026-11-05T10:00:00.000Z',
        'student',
        s,
      ),
    ),
    audit(
      'lecture.searched',
      null,
      { classSectionId: S1 },
      '2026-11-05T11:00:00.000Z',
      'student',
      student(1),
    ),
    ...range(4, 5).map((s) =>
      audit(
        'lecture.viewed',
        null,
        { classSectionId: S2 },
        '2026-11-05T10:00:00.000Z',
        'student',
        s,
      ),
    ),
  ];
  fake.transcripts = [
    {
      id: 't1',
      recordingSessionId: REC1,
      scheduledClassId: sc(S1, '2026-11-02'),
      processingVersion: 'v1',
      createdAt: '2026-11-03T00:30:00.000Z',
      stats: {
        segmentCount: 100,
        averageConfidence: 0.9,
        lowConfidenceSegmentCount: 3,
        correctedSegmentCount: 2,
      },
    },
    {
      id: 't2',
      recordingSessionId: REC2,
      scheduledClassId: sc(S1, '2026-11-04'),
      processingVersion: 'v1',
      createdAt: '2026-11-05T01:40:00.000Z',
      stats: {
        segmentCount: 90,
        averageConfidence: 0.8,
        lowConfidenceSegmentCount: 9,
        correctedSegmentCount: 0,
      },
    },
  ];
  const lecture = (
    id: string,
    createdAt: string,
    topics: { title: string; description?: string; subtopics?: { title: string }[] }[],
    concepts: { term: string; definition: string }[] = [],
  ) => ({
    lectureSummaryId: `ls-${id}`,
    scheduledClassId: id,
    transcriptId: 't',
    title: 'Aula',
    topics,
    concepts,
    createdAt,
  });
  fake.lectures.set(
    sc(S1, '2026-11-02'),
    lecture(
      sc(S1, '2026-11-02'),
      '2026-11-03T01:00:00.000Z',
      [
        {
          title: 'Controle de constitucionalidade',
          description: 'Modelos de controle das leis',
          subtopics: [{ title: 'Controle difuso' }],
        },
      ],
      [{ term: 'Habeas corpus', definition: 'Ação que protege a liberdade de locomoção' }],
    ),
  );
  fake.lectures.set(
    sc(S1, '2026-11-04'),
    lecture(sc(S1, '2026-11-04'), '2026-11-05T02:40:00.000Z', [
      { title: 'Direitos fundamentais', description: 'Direitos e garantias individuais' },
    ]),
  );
  fake.extractedEvents = [
    extracted('e1', {
      confirmationStatus: 'published',
      calendarEventId: 'ce1',
      changeHistory: [
        {
          changedAt: '2026-11-03T02:40:00.000Z',
          changedBy: PROF_A,
          source: 'professor',
          changeType: 'status_change',
          field: 'confirmationStatus',
        },
      ],
    }),
    extracted('e2', { type: 'assignment', title: 'Trabalho 1', eventDate: '2026-11-18' }),
    extracted('e3', {
      type: 'quiz',
      title: 'Quiz',
      confirmationStatus: 'rejected',
      changeHistory: [
        {
          changedAt: '2026-11-03T01:40:00.000Z',
          changedBy: PROF_A,
          source: 'professor',
          changeType: 'description_change',
          field: 'title',
        },
        {
          changedAt: '2026-11-03T01:45:00.000Z',
          changedBy: PROF_A,
          source: 'professor',
          changeType: 'status_change',
          field: 'confirmationStatus',
        },
      ],
    }),
    extracted('e4', { duplicateOf: 'e1' }),
  ];
  const cal = (id: string, section: string, course: string, type: string, eventDate: string) => ({
    id,
    institutionId: INST,
    courseId: course,
    classSectionId: section,
    extractedEventId: null,
    type,
    title: `${type} ${id}`,
    eventDate,
    eventTime: '19:00',
    isOfficial: true,
    status: 'published',
  });
  fake.calendarEvents = [
    cal('ce1', S1, C1, 'examination', '2026-11-20'),
    cal('ce2', S2, C2, 'quiz', '2026-11-20'),
    cal('ce3', S3, C3, 'reading_deadline', '2026-11-19'),
    cal('ce4', S1, C1, 'class_cancellation', '2026-11-19'),
    { ...cal('ce5', S2, C2, 'examination', '2026-11-25'), status: 'cancelled' },
  ];
  return { app, fake, directory, repository };
}
