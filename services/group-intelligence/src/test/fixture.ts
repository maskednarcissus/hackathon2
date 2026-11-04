import { generateKeyPairSync, sign } from 'node:crypto';
import { buildApp } from '../app.js';
import type { AdoptionResult, GenerateRequest } from '../clients.js';
import {
  FakeAiUsage,
  FakeAnalytics,
  FakeDevices,
  FakeGateway,
  FakeIncidents,
  FakeOrganization,
} from '../fakes.js';
import { createAccessTokenVerifier } from '../jwt-verify.js';
import { DEFAULT_PRICING } from '../pricing.js';
import { InMemoryWarehouse } from '../warehouse.js';

export const HC1 = '10000000-0000-4000-8000-000000000001';
export const HC2 = '10000000-0000-4000-8000-000000000002';
export const INST_A = '20000000-0000-4000-8000-00000000000a';
export const INST_B = '20000000-0000-4000-8000-00000000000b';
export const INST_C = '20000000-0000-4000-8000-00000000000c';
export const CAMPUS_A1 = '30000000-0000-4000-8000-0000000000a1';
export const CAMPUS_A2 = '30000000-0000-4000-8000-0000000000a2';
export const CAMPUS_B1 = '30000000-0000-4000-8000-0000000000b1';
export const COURSE_1 = '40000000-0000-4000-8000-000000000001';
export const COURSE_2 = '40000000-0000-4000-8000-000000000002';
export const INTERNAL = 'internal-secret-token-for-group-tests';
export const DATES = ['2026-11-02', '2026-11-03', '2026-11-04'] as const;
/** Distinctive numbers used only by the 3-student section — they must never appear in output. */
export const LEAK_MARKERS = [3_771, 3_772, 3_773] as const;

const NOW = new Date('2026-11-10T12:00:00Z');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

export function token(role: string, claims: Record<string, unknown> = {}, expOffset = 900): string {
  const now = Math.floor(NOW.getTime() / 1000);
  const head = b64({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' });
  const body = b64({
    iss: 'ci-identity',
    aud: 'ci',
    sub: '50000000-0000-4000-8000-000000000001',
    iat: now,
    exp: now + expOffset,
    jti: 'j1',
    inst: INST_A,
    role,
    ...claims,
  });
  const signature = sign(null, Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

export const executive = (hc = HC1): { authorization: string } => ({
  authorization: `Bearer ${token('group_executive', { hc })}`,
});
export const internal = { 'x-internal-token': INTERNAL };

function adoptionA(): AdoptionResult {
  return {
    professors: [
      ...Array.from({ length: 4 }, (_, i) => ({
        professorId: `p-a-${i}`,
        classesScheduled: 5,
        classesCaptured: 5,
        eventsReviewed: 2,
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        professorId: `p-a-x${i}`,
        classesScheduled: 5,
        classesCaptured: 4,
        eventsReviewed: 0,
      })),
    ],
    sections: [
      {
        classSectionId: 's-a-1',
        courseId: COURSE_1,
        engagement: {
          suppressed: false,
          cohortSize: 40,
          views: 120,
          searches: 30,
          assistantQuestions: 15,
          activeStudents: 40,
        },
      },
      {
        classSectionId: 's-a-2',
        courseId: COURSE_2,
        engagement: {
          suppressed: false,
          cohortSize: 12,
          views: 20,
          searches: 5,
          assistantQuestions: 4,
          activeStudents: 12,
        },
      },
    ],
    totals: {
      classesScheduled: 30,
      classesCaptured: 27,
      classesTranscribed: 26,
      classesStructured: 25,
      eventsExtracted: 10,
      eventsReviewed: 8,
      medianReviewLatencyMinutes: 95,
    },
  };
}

/** Institution B: tiny, with a 3-student section whose (wrongly unsuppressed) counts must not leak. */
function adoptionB(): AdoptionResult {
  return {
    professors: [
      { professorId: 'p-b-1', classesScheduled: 4, classesCaptured: 2, eventsReviewed: 0 },
    ],
    sections: [
      {
        classSectionId: 's-b-1',
        courseId: null,
        engagement: {
          suppressed: false,
          cohortSize: 3,
          views: LEAK_MARKERS[0],
          searches: LEAK_MARKERS[1],
          assistantQuestions: LEAK_MARKERS[2],
          activeStudents: 3,
        },
      },
    ],
    totals: {
      classesScheduled: 4,
      classesCaptured: 2,
      classesTranscribed: 2,
      classesStructured: 1,
      eventsExtracted: 1,
      eventsReviewed: 0,
      medianReviewLatencyMinutes: null,
    },
  };
}

export interface Fixture {
  app: ReturnType<typeof buildApp>;
  org: FakeOrganization;
  analytics: FakeAnalytics;
  aiUsage: FakeAiUsage;
  devices: FakeDevices;
  incidents: FakeIncidents;
  gateway: FakeGateway;
  warehouse: InMemoryWarehouse;
}

export function setup(
  options: {
    authDisabled?: boolean;
    script?: Record<string, (req: GenerateRequest) => unknown>;
  } = {},
): Fixture {
  const org = new FakeOrganization();
  org.institutions = [
    { id: INST_A, name: 'Faculdade Alfa', holdingCompanyId: HC1, state: 'SP' },
    { id: INST_B, name: 'Instituto Beta', holdingCompanyId: HC1, state: 'MG' },
    { id: INST_C, name: 'Universidade Gama', holdingCompanyId: HC2, state: 'RJ' },
  ];
  org.campuses = [
    { id: CAMPUS_A1, institutionId: INST_A, name: 'Campus Centro' },
    { id: CAMPUS_A2, institutionId: INST_A, name: 'Campus Norte' },
    { id: CAMPUS_B1, institutionId: INST_B, name: 'Campus Único' },
  ];
  const analytics = new FakeAnalytics();
  const aiUsage = new FakeAiUsage();
  const devices = new FakeDevices();
  const incidents = new FakeIncidents();
  for (const d of DATES) {
    analytics.capture.set(`${INST_A}|${d}`, [
      { date: d, campusId: CAMPUS_A1, scheduled: 20, captured: 18 },
      { date: d, campusId: CAMPUS_A2, scheduled: 10, captured: 9 },
    ]);
    analytics.adoptions.set(`${INST_A}|${d}`, adoptionA());
    analytics.capture.set(`${INST_B}|${d}`, [
      { date: d, campusId: CAMPUS_B1, scheduled: 4, captured: 2 },
    ]);
    analytics.adoptions.set(`${INST_B}|${d}`, adoptionB());
    aiUsage.usages.set(`${INST_A}|${d}`, {
      totals: { calls: 100, inputTokens: 200_000, outputTokens: 20_000, costUsd: 1.25 },
      byTask: [
        {
          key: 'lecture_structuring',
          calls: 60,
          inputTokens: 150_000,
          outputTokens: 15_000,
          costUsd: 1,
        },
        {
          key: 'event_extraction',
          calls: 40,
          inputTokens: 50_000,
          outputTokens: 5_000,
          costUsd: 0.25,
        },
      ],
      byModel: [
        {
          key: 'vertex/gemini-2.5-flash',
          calls: 100,
          inputTokens: 200_000,
          outputTokens: 20_000,
          costUsd: 1.25,
        },
      ],
      byPromptVersion: [],
    });
    aiUsage.usages.set(`${INST_B}|${d}`, {
      totals: { calls: 5, inputTokens: 10_000, outputTokens: 1_000, costUsd: 0.05 },
      byTask: [
        {
          key: 'event_extraction',
          calls: 5,
          inputTokens: 10_000,
          outputTokens: 1_000,
          costUsd: 0.05,
        },
      ],
      byModel: [
        {
          key: 'vertex/gemini-2.5-flash',
          calls: 5,
          inputTokens: 10_000,
          outputTokens: 1_000,
          costUsd: 0.05,
        },
      ],
      byPromptVersion: [],
    });
    incidents.stats_.set(`${INST_A}|${d}`, { raised: 2, resolved: 1, mttrMinutes: 45 });
  }
  // Whole-range usage for the live AI usage endpoint.
  aiUsage.usages.set(INST_A, {
    totals: { calls: 300, inputTokens: 600_000, outputTokens: 60_000, costUsd: 3.75 },
    byTask: [
      {
        key: 'lecture_structuring',
        calls: 180,
        inputTokens: 450_000,
        outputTokens: 45_000,
        costUsd: 3,
      },
      {
        key: 'event_extraction',
        calls: 120,
        inputTokens: 150_000,
        outputTokens: 15_000,
        costUsd: 0.75,
      },
    ],
    byModel: [],
    byPromptVersion: [],
  });
  aiUsage.usages.set(INST_B, {
    totals: { calls: 15, inputTokens: 30_000, outputTokens: 3_000, costUsd: 0.15 },
    byTask: [
      {
        key: 'event_extraction',
        calls: 15,
        inputTokens: 30_000,
        outputTokens: 3_000,
        costUsd: 0.15,
      },
    ],
    byModel: [],
    byPromptVersion: [],
  });
  devices.fleets.set(INST_A, {
    total: 10,
    byStatus: { online: 6, recording: 2, offline: 2 },
    byCampus: [
      { campusId: CAMPUS_A1, total: 7, online: 6 },
      { campusId: CAMPUS_A2, total: 3, online: 2 },
    ],
    firmwareCurrentPct: 90,
  });
  devices.fleets.set(INST_B, {
    total: 1,
    byStatus: { offline: 1 },
    byCampus: [{ campusId: CAMPUS_B1, total: 1, online: 0 }],
    firmwareCurrentPct: 0,
  });
  analytics.rangeAdoption.set(INST_A, adoptionA());
  analytics.rangeAdoption.set(INST_B, adoptionB());
  analytics.coverage.set(COURSE_1, 0.8);
  analytics.coverage.set(COURSE_2, 0.6);
  analytics.summaries.set(INST_A, {
    transcription: { captured: 81, transcribed: 78, failed: 1 },
    corrections: {
      transcriptSegmentsCorrected: 39,
      eventEdits: 2,
      eventRejections: 1,
      eventsExtracted: 30,
    },
  });
  analytics.assessments.set(INST_A, { assessments: 12, days: 6, maxDailyLoad: 4 });
  analytics.conflicts.set(INST_A, 3);

  const gateway = new FakeGateway(options.script ?? {});
  const warehouse = new InMemoryWarehouse();
  const app = buildApp({
    sources: { organization: org, analytics, aiUsage, devices, incidents },
    gateway,
    warehouse,
    pricing: DEFAULT_PRICING,
    auth: {
      disabled: options.authDisabled ?? false,
      verifier: createAccessTokenVerifier({ getKey: () => publicKey, now: () => NOW }),
      internalToken: INTERNAL,
    },
    clock: { now: () => NOW },
    defaultHoldingCompanyIds: [HC1, HC2],
  });
  return { app, org, analytics, aiUsage, devices, incidents, gateway, warehouse };
}

export async function buildFacts(f: Fixture): Promise<void> {
  for (const date of DATES) {
    const res = await f.app.inject({
      method: 'POST',
      url: '/v1/pipeline/run',
      headers: internal,
      payload: { date },
    });
    if (res.statusCode !== 200) throw new Error(`pipeline failed: ${res.body}`);
  }
}

export const range = '?from=2026-11-02&to=2026-11-04';
