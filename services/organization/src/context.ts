import type { AuditClient, AuditEventInput, RetentionTarget, RosterClient } from './clients.js';
import type { Institution, RecordingPolicy } from './domain.js';
import type { OrganizationRepository } from './repository.js';

export interface Clock {
  now(): Date;
}

/** Shared dependencies and lookups handed to route modules. */
export interface ServiceContext {
  repo: OrganizationRepository;
  clock: Clock;
  idGenerator: () => string;
  audit: AuditClient;
  roster: RosterClient;
  retentionTargets: readonly RetentionTarget[];
  requireInstitution(id: string): Promise<Institution>;
  requirePolicy(id: string): Promise<RecordingPolicy>;
  defaultPolicy(institutionId: string): Promise<RecordingPolicy | undefined>;
  /** Never throws. */
  recordAudit(event: AuditEventInput): Promise<void>;
}
