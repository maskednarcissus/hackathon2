import { z } from 'zod';
import { ALERT_RULES, ALERT_STATUSES, SEVERITIES } from './domain.js';

const iso = z.string().datetime({ offset: true });
const id = z.string().min(1).max(200);

/** Event envelope — contract §6. */
export const EventEnvelopeSchema = z.object({
  eventId: z.string().uuid(),
  type: z.string().min(1).max(100),
  version: z.number().int().positive(),
  occurredAt: iso,
  source: z.string().min(1).max(100),
  institutionId: z.string().uuid().nullable().optional(),
  data: z.record(z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const ClassWindowSchema = z.object({
  scheduledClassId: id,
  classroomId: id,
  deviceId: id.nullable().optional(),
  institutionId: z.string().uuid().nullable().optional(),
  recordStartAt: iso,
  recordStopAt: iso,
  recordingEnabled: z.boolean().optional(),
});
export type ClassWindow = z.infer<typeof ClassWindowSchema>;

export const DeviceSnapshotSchema = z.object({
  deviceId: id,
  classroomId: id.nullable().optional(),
  institutionId: z.string().uuid().nullable().optional(),
  lastSeenAt: iso.nullable(),
  diskFreeBytes: z.number().int().nonnegative().nullable().optional(),
  status: z.string().optional(),
});
export type DeviceSnapshot = z.infer<typeof DeviceSnapshotSchema>;

export const EvaluateRequestSchema = z.object({
  now: iso.optional(),
  classWindows: z.array(ClassWindowSchema).max(10_000).default([]),
  devices: z.array(DeviceSnapshotSchema).max(10_000).default([]),
});
export type EvaluateRequest = z.infer<typeof EvaluateRequestSchema>;

export const AlertQuerySchema = z.object({
  status: z.enum(ALERT_STATUSES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  rule: z.enum(ALERT_RULES).optional(),
  classroomId: id.optional(),
  deviceId: id.optional(),
  institutionId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type AlertQuery = z.infer<typeof AlertQuerySchema>;

export const AlertActionSchema = z.object({
  actorId: id,
  note: z.string().max(2000).optional(),
});
