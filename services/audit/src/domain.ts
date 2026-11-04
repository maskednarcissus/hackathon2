export const ACTOR_TYPES = [
  'student',
  'professor',
  'coordinator',
  'admin',
  'system',
  'device',
] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** Fields covered by the hash. */
export interface AuditEventBody {
  id: string;
  tenantId: string | null;
  sequence: number;
  actorId: string | null;
  actorType: ActorType;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  occurredAt: string;
  recordedAt: string;
}

export interface AuditEvent extends AuditEventBody {
  /** Global insertion order, used for cursor pagination. */
  position: number;
  prevHash: string;
  hash: string;
}

export function bodyOf(e: AuditEvent): AuditEventBody {
  return {
    id: e.id,
    tenantId: e.tenantId,
    sequence: e.sequence,
    actorId: e.actorId,
    actorType: e.actorType,
    action: e.action,
    resourceType: e.resourceType,
    resourceId: e.resourceId,
    metadata: e.metadata,
    ipAddress: e.ipAddress,
    occurredAt: e.occurredAt,
    recordedAt: e.recordedAt,
  };
}
