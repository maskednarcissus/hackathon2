import { z } from 'zod';

export const IdParams = z.object({ id: z.string().uuid() });

const isValidTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const name = z.string().trim().min(1).max(255);

export const HoldingCompanyCreate = z.object({
  name,
  legalName: name,
  country: z.string().length(2).toUpperCase().default('BR'),
});
export const HoldingCompanyUpdate = HoldingCompanyCreate.partial();

export const InstitutionCreate = z.object({
  holdingCompanyId: z.string().uuid(),
  name,
  brand: z.string().trim().min(1).max(100).optional(),
  country: z.string().length(2).toUpperCase().default('BR'),
  state: z.string().trim().min(1).max(50),
});
export const InstitutionUpdate = InstitutionCreate.omit({ holdingCompanyId: true }).partial();

export const CampusCreate = z.object({
  institutionId: z.string().uuid(),
  name,
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(50),
  timezone: z
    .string()
    .refine(isValidTimezone, 'Invalid IANA timezone')
    .default('America/Sao_Paulo'),
  recordingPolicyId: z.string().uuid().optional(),
});
export const CampusUpdate = CampusCreate.omit({ institutionId: true })
  .partial()
  .extend({ recordingPolicyId: z.string().uuid().nullable().optional() });

export const ClassroomCreate = z.object({
  campusId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  code: z.string().trim().min(1).max(50),
  capacity: z.number().int().positive().optional(),
  recordingPolicyId: z.string().uuid().optional(),
});
export const ClassroomUpdate = ClassroomCreate.omit({ campusId: true })
  .partial()
  .extend({ recordingPolicyId: z.string().uuid().nullable().optional() });

const retentionDays = z.number().int().min(1).max(3650);

export const RecordingPolicyCreate = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).optional(),
  legalBasis: z.string().trim().min(1).max(100),
  requiresExplicitConsent: z.boolean().default(false),
  audioRetentionDays: retentionDays.default(90),
  transcriptRetentionDays: retentionDays.default(365),
  summaryRetentionDays: retentionDays.default(730),
  allowRawAudioAccess: z.boolean().default(false),
  preRollMinutes: z.number().int().min(0).max(30).default(2),
  postRollMinutes: z.number().int().min(0).max(60).default(5),
  recordingEnabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});
export const RecordingPolicyUpdate = RecordingPolicyCreate.partial();

export const ListQuery = z.object({
  holdingCompanyId: z.string().uuid().optional(),
  institutionId: z.string().uuid().optional(),
  campusId: z.string().uuid().optional(),
});
