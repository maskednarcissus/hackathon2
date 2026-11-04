/** Helpers shared by the LMS connectors. */
import type { ConnectorConfig } from './types.js';

/**
 * Class section externalId for an LMS course/section: explicit `mappings.sections` first (by any of
 * the given LMS ids), then — with `matchByExternalId` — the SIS id the LMS carries.
 */
export function sectionFor(
  config: ConnectorConfig,
  lmsIds: (string | undefined)[],
  sisId: string | undefined,
): string | undefined {
  for (const id of lmsIds) {
    const mapped = id ? config.mappings.sections[id] : undefined;
    if (mapped) return mapped;
  }
  return config.mappings.matchByExternalId && sisId ? sisId : undefined;
}

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
