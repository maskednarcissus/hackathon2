/**
 * Group fact tables (Phase 5 §3). Rows hold aggregates only — never student identifiers.
 * Student-derived fields are `null` when the underlying cohort is smaller than MIN_COHORT.
 */

export const MIN_COHORT = 5;

export interface InstitutionDaily {
  holdingCompanyId: string;
  institutionId: string;
  date: string; // YYYY-MM-DD
  classesScheduled: number;
  classesCaptured: number;
  classesTranscribed: number;
  classesStructured: number;
  eventsExtracted: number;
  eventsReviewed: number;
  professorsTeaching: number;
  activeProfessors: number;
  /** Students active in sections whose cohort is ≥ 5; null when suppressed. */
  activeStudents: number | null;
  assistantQuestions: number | null;
  searches: number | null;
  devicesTotal: number;
  devicesOnline: number;
  deviceUptimePct: number | null;
  firmwareCurrentPct: number | null;
  incidentsOpened: number;
  incidentsResolved: number;
  mttrMinutes: number | null;
  aiCostUsd: number;
  sttCostUsd: number;
  storageCostUsd: number;
  infraCostUsd: number;
  builtAt: string;
}

export interface CampusDaily {
  holdingCompanyId: string;
  institutionId: string;
  campusId: string;
  date: string;
  classesScheduled: number;
  classesCaptured: number;
  devicesTotal: number;
  devicesOnline: number;
  sttCostUsd: number;
  storageCostUsd: number;
  hardwareCostUsd: number;
  builtAt: string;
}

export const COST_CATEGORIES = ['ai', 'stt', 'storage', 'compute', 'hardware'] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export interface CostDaily {
  holdingCompanyId: string;
  institutionId: string;
  campusId: string | null;
  date: string;
  category: CostCategory;
  amountUsd: number;
  /** Where the number comes from, e.g. "ai-gateway:/v1/usage" or "pricing:sttUsdPerMinute×minutes". */
  source: string;
}

export interface CostAllocation {
  id: string;
  holdingCompanyId: string;
  institutionId: string;
  month: string; // YYYY-MM
  category: Extract<CostCategory, 'compute'>;
  amountUsd: number;
  note: string | null;
  createdAt: string;
}

export interface PipelineRun {
  id: string;
  date: string;
  holdingCompanyIds: string[];
  status: 'completed' | 'completed_with_errors' | 'failed';
  startedAt: string;
  finishedAt: string;
  institutions: number;
  errors: { institutionId: string | null; source: string; message: string }[];
}

export interface Provenance {
  sources: string[];
  generatedAt: string;
  dataThrough: string | null;
  limitations: string[];
}

export interface InstitutionRef {
  id: string;
  name: string;
  holdingCompanyId: string;
  state: string | null;
}

export interface CampusRef {
  id: string;
  institutionId: string;
  name: string;
}
