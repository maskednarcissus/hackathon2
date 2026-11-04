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
  extractedEventRetentionDays: retentionDays.default(1825),
  isDefault: z.boolean().default(false),
  actorId: z.string().uuid().optional(),
});
export const RecordingPolicyUpdate = RecordingPolicyCreate.partial().extend({
  changeReason: z.string().trim().min(1).max(1000).optional(),
});

export const VersionParams = z.object({
  id: z.string().uuid(),
  version: z.coerce.number().int().min(1),
});

export const RecordingPolicyQuery = z.object({ classSectionId: z.string().uuid().optional() });

export const ConsentCreate = z.object({
  subjectType: z.enum(['student', 'professor']),
  subjectId: z.string().uuid(),
  policyId: z.string().uuid(),
  classSectionId: z.string().uuid().optional(),
  given: z.boolean(),
  actorId: z.string().uuid(),
});

export const ConsentWithdraw = z.object({
  actorId: z.string().uuid(),
  reason: z.string().trim().min(1).max(1000).optional(),
});

export const ConsentQuery = z
  .object({
    policyId: z.string().uuid().optional(),
    classSectionId: z.string().uuid().optional(),
    subjectId: z.string().uuid().optional(),
    includeHistory: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
  })
  .refine((q) => q.policyId ?? q.classSectionId ?? q.subjectId, {
    message: 'At least one of policyId, classSectionId or subjectId is required',
  });

export const ConsentStatusQuery = z.object({ policyId: z.string().uuid().optional() });

export const LegalHoldCreate = z.object({
  institutionId: z.string().uuid(),
  scope: z.object({
    type: z.enum(['class_section', 'recording', 'subject']),
    id: z.string().uuid(),
  }),
  reason: z.string().trim().min(3).max(2000),
  actorId: z.string().uuid(),
});

export const LegalHoldRelease = z.object({
  actorId: z.string().uuid(),
  reason: z.string().trim().min(1).max(1000).optional(),
});

export const LegalHoldQuery = z.object({
  institutionId: z.string().uuid(),
  active: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const RetentionRun = z.object({
  institutionId: z.string().uuid(),
  now: z.string().datetime({ offset: true }).optional(),
  dryRun: z.boolean().default(false),
  actorId: z.string().uuid().optional(),
});

export const RetentionJobsQuery = z.object({
  institutionId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ListQuery = z.object({
  holdingCompanyId: z.string().uuid().optional(),
  institutionId: z.string().uuid().optional(),
  campusId: z.string().uuid().optional(),
});
