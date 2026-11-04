import type { ImportIssue, ImportReport } from './domain.js';
import { planImport } from './importer.js';
import type { AcademicRepository } from './repository.js';
import { ImportPayloadSchema, formatPath } from './schemas.js';
import type { SyncService } from './sync.js';

export const emptyCounts = (): ImportReport['counts'] => {
  const c = () => ({ created: 0, updated: 0, unchanged: 0 });
  return {
    terms: c(),
    courses: c(),
    professors: c(),
    students: c(),
    classSections: c(),
    enrollments: c(),
    scheduledClasses: c(),
    scheduledClassesCancelled: 0,
  };
};

export type ImportRunner = (
  raw: unknown,
  format: ImportReport['format'],
  preErrors: ImportIssue[],
  institutionIdHint: string | null,
) => Promise<ImportReport>;

/**
 * Validates, plans and (unless dry run) applies a canonical import, stores the report and schedules
 * the downstream sync push. Shared by `POST /v1/imports`, the CSV import and connector syncs.
 */
export function createImportRunner(deps: {
  repository: AcademicRepository;
  clock: { now(): Date };
  newId: () => string;
  sync?: SyncService;
  onSyncError?: (err: unknown) => void;
}): ImportRunner {
  const repo = deps.repository;
  return async (raw, format, preErrors, institutionIdHint) => {
    const importId = deps.newId();
    const createdAt = deps.clock.now().toISOString();
    const parsed = preErrors.length === 0 ? ImportPayloadSchema.safeParse(raw) : null;
    if (!parsed || !parsed.success) {
      const errors =
        parsed && !parsed.success
          ? parsed.error.issues.map((i) => ({
              path: formatPath(i.path) || '(root)',
              code: i.code,
              message: i.message,
            }))
          : preErrors;
      const institutionId =
        typeof (raw as { institutionId?: unknown } | null)?.institutionId === 'string'
          ? String((raw as { institutionId: string }).institutionId)
          : (institutionIdHint ?? '');
      const dryRun = (raw as { dryRun?: unknown } | null)?.dryRun === true;
      const report: ImportReport = {
        importId,
        institutionId,
        format,
        dryRun,
        status: 'rejected',
        errors,
        warnings: [],
        counts: emptyCounts(),
        createdAt,
      };
      await repo.saveImportReport(report);
      return report;
    }
    const payload = parsed.data;
    const plan = planImport(payload, await repo.snapshot(payload.institutionId), deps.newId);
    const rejected = plan.errors.length > 0;
    if (!rejected && !payload.dryRun) {
      await repo.apply(plan.changes);
      // Fire-and-forget: the import response never waits for downstream services.
      deps.sync?.schedule(payload.institutionId).catch((err: unknown) => deps.onSyncError?.(err));
    }
    const report: ImportReport = {
      importId,
      institutionId: payload.institutionId,
      format,
      dryRun: payload.dryRun,
      status: rejected ? 'rejected' : payload.dryRun ? 'validated' : 'applied',
      errors: plan.errors,
      warnings: plan.warnings,
      counts: plan.counts,
      createdAt,
    };
    await repo.saveImportReport(report);
    return report;
  };
}
