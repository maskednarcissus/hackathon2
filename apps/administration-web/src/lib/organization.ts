/** organization hierarchy client (used for filter options). Server-side only. */
import type { ApiResult } from './fleet';
import { apiGet, institutionId } from './http';

export interface InstitutionTree {
  institution: { id: string; name: string };
  campuses: { id: string; name: string; classrooms: { id: string; name: string; code: string }[] }[];
}

export const getInstitutionTree = (): Promise<ApiResult<InstitutionTree>> =>
  apiGet('organization', `/v1/institutions/${encodeURIComponent(institutionId())}/tree`);
