import { randomUUID } from 'node:crypto';
import { buildApp } from '../app.js';
import { StaticLectureClient, type LectureStructure } from '../concepts/lectures.js';
import { InMemoryConceptRepository, type ConceptRepository } from '../concepts/model.js';
import { InMemoryTranscriptRepository, type TranscriptRepository } from '../repository.js';

export const COURSE = 'c0000000-0000-4000-8000-0000000000c1';
export const SEC_A = '5aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const SEC_B = '5bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const OTHER = '5ccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const TOKEN = 'internal-secret';

export const lectureFixtures = (transcriptIds: Record<string, string>): LectureStructure[] => [
  {
    lectureSummaryId: randomUUID(),
    transcriptId: transcriptIds['l1'] ?? '',
    scheduledClassId: 'd0000000-0000-4000-8000-000000000001',
    institutionId: '11111111-1111-4111-8111-111111111111',
    classSectionId: SEC_A,
    courseId: COURSE,
    startsAt: '2026-11-02T22:00:00.000Z',
    concepts: [
      {
        term: 'Curva IS',
        definition: 'Equilíbrio no mercado de bens; relacionada à curva LM no modelo IS-LM.',
        segmentIndexes: [1],
      },
      { term: 'Curva LM', definition: 'Equilíbrio no mercado monetário.', segmentIndexes: [2] },
      {
        term: 'Política fiscal',
        definition: 'Uso de gastos e tributos pelo governo.',
        segmentIndexes: [3],
      },
    ],
  },
  {
    lectureSummaryId: randomUUID(),
    transcriptId: transcriptIds['l2'] ?? '',
    scheduledClassId: 'd0000000-0000-4000-8000-000000000002',
    institutionId: '11111111-1111-4111-8111-111111111111',
    classSectionId: SEC_B,
    courseId: COURSE,
    startsAt: '2026-11-04T22:00:00.000Z',
    concepts: [
      {
        term: 'curvas LM',
        definition: 'Combinações de juros e renda que equilibram o mercado monetário.',
        segmentIndexes: [0, 1],
      },
      {
        term: 'Armadilha da liquidez',
        definition: 'Situação em que a curva LM é horizontal.',
        segmentIndexes: [1],
      },
    ],
  },
];

export const envelope = (scheduledClassId: string, eventId = randomUUID()) => ({
  eventId,
  type: 'lecture.structured',
  version: 1,
  occurredAt: '2026-11-04T23:00:00.000Z',
  source: 'lecture-intelligence',
  institutionId: '11111111-1111-4111-8111-111111111111',
  data: { scheduledClassId, transcriptId: randomUUID(), lectureSummaryId: randomUUID() },
});

export async function seedTranscripts(
  app: ReturnType<typeof buildApp>,
): Promise<Record<string, string>> {
  const create = async (rec: string, section: string, texts: string[]): Promise<string> =>
    (
      await app.inject({
        method: 'POST',
        url: '/v1/transcripts',
        payload: {
          recordingSessionId: rec,
          classSectionId: section,
          institutionId: '11111111-1111-4111-8111-111111111111',
          processingVersion: 'v1',
          provider: 'google',
          model: 'chirp_2',
          segments: texts.map((text, i) => ({
            segmentIndex: i,
            startMs: i * 10_000,
            endMs: i * 10_000 + 9000,
            text,
            confidence: 0.9,
          })),
        },
      })
    ).json<{ id: string }>().id;
  return {
    l1: await create('a0000000-0000-4000-8000-000000000001', SEC_A, [
      'Bom dia.',
      'A curva IS mostra o equilíbrio de bens.',
      'A curva LM trata do mercado monetário.',
      'O governo usa a política fiscal.',
    ]),
    l2: await create('a0000000-0000-4000-8000-000000000002', SEC_B, [
      'Retomando o mercado de moeda.',
      'Quando a LM fica horizontal temos uma armadilha.',
    ]),
  };
}

export async function setupConcepts(
  repo: ConceptRepository = new InMemoryConceptRepository(),
  transcripts: TranscriptRepository = new InMemoryTranscriptRepository(),
) {
  const lectures = new StaticLectureClient();
  const app = buildApp({ repository: transcripts, concepts: repo, lectures, internalToken: TOKEN });
  const ids = await seedTranscripts(app);
  for (const l of lectureFixtures(ids)) lectures.lectures.set(l.scheduledClassId, l);
  const push = (body: unknown) =>
    app.inject({
      method: 'POST',
      url: '/v1/events/lecture-structured',
      headers: { 'x-internal-token': TOKEN },
      payload: body as Record<string, unknown>,
    });
  return { app, lectures, push, ids };
}
