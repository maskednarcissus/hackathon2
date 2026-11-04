import { z } from 'zod';
import type { ContentReportRepository } from './content-reports.js';
import type { AuditRepository } from './repository.js';

/** Identity DSR handler contract (phase-4 §6, integration-stage §5). */
export const DSR_TYPES = [
  'access',
  'correction',
  'deletion',
  'anonymization',
  'restriction',
] as const;
export type DsrType = (typeof DSR_TYPES)[number];

export const DsrPayloadSchema = z.object({
  subjectType: z.enum(['student', 'professor']),
  subjectId: z.string().uuid(),
  requestId: z.string().uuid(),
  institutionId: z.string().uuid(),
  details: z.record(z.unknown()).optional(),
});
export type DsrPayload = z.infer<typeof DsrPayloadSchema>;

export interface DsrResult {
  service: 'audit';
  status: 'completed' | 'not_applicable';
  items: unknown;
}

const MAX_EXPORTED_EVENTS = 10_000;

export const AUDIT_RETENTION_LEGAL_BASIS =
  'Registros de auditoria são mantidos por 7 anos para cumprimento de obrigação legal e regulatória ' +
  'e exercício regular de direitos (LGPD art. 7º, II e VI; art. 16, I) e não podem ser alterados ou apagados.';

/**
 * access → every audit event performed by the subject plus their content reports.
 * deletion / anonymization → audit events are retained (`not_applicable`, with the legal basis);
 * content reports they authored are anonymised. correction / restriction → `not_applicable`.
 */
export async function handleDsr(
  type: DsrType,
  p: DsrPayload,
  audit: AuditRepository,
  reports: ContentReportRepository,
): Promise<DsrResult> {
  if (type === 'access') {
    const events = (await audit.byActor(p.subjectId, MAX_EXPORTED_EVENTS + 1)).filter(
      (e) => e.tenantId === p.institutionId || e.tenantId === null,
    );
    const authored = (await reports.byReporter(p.subjectId)).filter(
      (r) => r.institutionId === p.institutionId,
    );
    return {
      service: 'audit',
      status: 'completed',
      items: {
        auditEvents: events.slice(0, MAX_EXPORTED_EVENTS).map((e) => ({
          id: e.id,
          action: e.action,
          resourceType: e.resourceType,
          resourceId: e.resourceId,
          occurredAt: e.occurredAt,
          ipAddress: e.ipAddress,
          metadata: e.metadata,
        })),
        auditEventsTruncated: events.length > MAX_EXPORTED_EVENTS,
        contentReports: authored,
      },
    };
  }
  if (type === 'deletion' || type === 'anonymization') {
    const anonymised = await reports.anonymiseReporter(p.subjectId);
    return {
      service: 'audit',
      status: 'not_applicable',
      items: {
        auditEvents: { retained: true, retentionYears: 7, legalBasis: AUDIT_RETENTION_LEGAL_BASIS },
        contentReportsAnonymised: anonymised,
      },
    };
  }
  return {
    service: 'audit',
    status: 'not_applicable',
    items: { reason: 'Audit records are immutable', legalBasis: AUDIT_RETENTION_LEGAL_BASIS },
  };
}
