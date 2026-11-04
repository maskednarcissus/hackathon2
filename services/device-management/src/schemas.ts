import { z } from 'zod';

export const IdParams = z.object({ id: z.string().uuid() });

const serialNumber = z
  .string()
  .trim()
  .min(3)
  .max(100)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'Serial numbers may only contain letters, digits, ".", "_" and "-"',
  );

export const ProvisioningTokenCreate = z.object({
  serialNumber,
  institutionId: z.string().uuid(),
  expiresInHours: z.number().int().min(1).max(720).default(72),
});

export const RegisterDevice = z.object({
  provisioningToken: z.string().min(10).max(200),
  serialNumber,
  model: z.string().trim().min(1).max(100),
  firmwareVersion: z.string().trim().min(1).max(50),
  publicKeyPem: z.string().min(40).max(4096),
});

export const AssignDevice = z.object({ classroomId: z.string().uuid() });

export const RevokeDevice = z.object({ reason: z.string().trim().min(3).max(500) });

export const MaintenanceMode = z.object({ enabled: z.boolean() });

const isoDateTime = z.string().datetime({ offset: true });

export const HeartbeatBody = z.object({
  firmwareVersion: z.string().trim().min(1).max(50),
  uptimeSeconds: z.number().int().nonnegative().optional(),
  cpuTempC: z.number().min(-40).max(150).optional(),
  diskFreeBytes: z.number().int().nonnegative(),
  diskTotalBytes: z.number().int().positive(),
  bufferQueueCount: z.number().int().nonnegative(),
  bufferQueueBytes: z.number().int().nonnegative(),
  networkRssiDbm: z.number().min(-130).max(0).optional(),
  micLevelDbfs: z.number().min(-160).max(0).optional(),
  isRecording: z.boolean(),
  currentScheduledClassId: z.string().uuid().optional(),
  lastUploadAt: isoDateTime.optional(),
  evictedRecordings: z.number().int().nonnegative().optional(),
  clockSkewMs: z.number().int().optional(),
  lastError: z.string().max(1000).optional(),
});

export const FleetQuery = z.object({
  institutionId: z.string().uuid().optional(),
  classroomId: z.string().uuid().optional(),
  status: z
    .enum([
      'online',
      'offline',
      'recording',
      'uploading',
      'attention_required',
      'maintenance',
      'decommissioned',
    ])
    .optional(),
});

export const HealthQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(60) });

export const PlanQuery = z.object({ from: isoDateTime.optional(), to: isoDateTime.optional() });

const deviceStatus = z.enum([
  'online',
  'offline',
  'recording',
  'uploading',
  'attention_required',
  'maintenance',
  'decommissioned',
]);

export const FLEET_SORTS = [
  'serialNumber',
  'status',
  'lastSeenAt',
  'firmwareVersion',
  'classroom',
  'campus',
] as const;

export const FleetConsoleQuery = z.object({
  institutionId: z.string().uuid().optional(),
  campusId: z.string().uuid().optional(),
  status: deviceStatus.optional(),
  firmwareVersion: z.string().trim().min(1).max(50).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  sort: z
    .string()
    .regex(new RegExp(`^-?(${FLEET_SORTS.join('|')})$`), 'Unsupported sort field')
    .default('serialNumber'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const FirmwareQuery = z.object({ institutionId: z.string().uuid().optional() });

export const DiagnosticsQuery = z.object({
  windowHours: z.coerce.number().int().min(1).max(24).default(24),
});

export const CommandCreate = z.object({
  type: z.enum(['reboot', 'self_test', 'upload_now', 'refresh_plan', 'rotate_logs']),
  requestedBy: z.string().uuid(),
  ttlMinutes: z.number().int().min(1).max(30).default(30),
});

export const CommandParams = z.object({ id: z.string().uuid(), commandId: z.string().uuid() });

export const CommandResult = z.object({
  status: z.enum(['succeeded', 'failed']),
  output: z.union([z.string().max(10_000), z.record(z.unknown())]).optional(),
  finishedAt: isoDateTime,
});

export const CommandListQuery = z.object({
  status: z
    .enum(['pending', 'delivered', 'succeeded', 'failed', 'expired', 'cancelled'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const CommandCancel = z.object({ actorId: z.string().uuid().optional() });
