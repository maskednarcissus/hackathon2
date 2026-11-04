import type { Repositories, UserRecord } from './repositories.js';

export const RESOURCE_TYPES = [
  'class_section',
  'scheduled_class',
  'transcript',
  'lecture',
  'calendar_event',
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export type AuthorizationReason =
  | 'enrolled'
  | 'teaches_section'
  | 'institution_staff'
  | 'not_enrolled'
  | 'enrollment_inactive'
  | 'not_teaching'
  | 'cross_institution'
  | 'section_unknown'
  | 'user_inactive'
  | 'user_unknown'
  | 'invalid_token'
  | 'group_scope_only';

export interface AuthorizationDecision {
  allowed: boolean;
  reason: AuthorizationReason;
}

const allow = (reason: AuthorizationReason): AuthorizationDecision => ({ allowed: true, reason });
const deny = (reason: AuthorizationReason): AuthorizationDecision => ({ allowed: false, reason });

/**
 * Contract §2 rules. Every resource type is resolved through its class section:
 *  - students: only sections with an `active` enrollment;
 *  - professors: only sections they teach;
 *  - coordinators/admins: sections of their own institution;
 *  - cross-institution access is always denied (checked first, for every role).
 */
export async function authorizeSectionAccess(
  repos: Repositories,
  user: UserRecord | undefined,
  classSectionId: string,
): Promise<AuthorizationDecision> {
  if (!user) return deny('user_unknown');
  if (user.status !== 'active') return deny('user_inactive');

  // Phase 5 §2: group executives read aggregates only through group-intelligence.
  if (user.role === 'group_executive') return deny('group_scope_only');
  const section = await repos.access.findSection(classSectionId);
  if (!section) return deny('section_unknown');
  if (section.institutionId !== user.institutionId) return deny('cross_institution');

  switch (user.role) {
    case 'student': {
      if (!user.studentId) return deny('not_enrolled');
      const enrollment = await repos.access.findEnrollment(user.studentId, classSectionId);
      if (!enrollment || enrollment.institutionId !== user.institutionId)
        return deny('not_enrolled');
      return enrollment.status === 'active' ? allow('enrolled') : deny('enrollment_inactive');
    }
    case 'professor':
      return user.professorId !== null && section.professorId === user.professorId
        ? allow('teaches_section')
        : deny('not_teaching');
    case 'coordinator':
    case 'admin':
      return allow('institution_staff');
  }
}

/** Class sections the user may read, applying exactly the same rules as authorizeSectionAccess. */
export async function accessibleSectionIds(
  repos: Repositories,
  user: UserRecord,
): Promise<string[]> {
  if (user.status !== 'active') return [];
  const sections = await repos.access.listSectionsByInstitution(user.institutionId);
  switch (user.role) {
    case 'student': {
      if (!user.studentId) return [];
      const enrollments = await repos.access.listEnrollmentsByStudent(user.studentId);
      const active = new Set(
        enrollments
          .filter((e) => e.status === 'active' && e.institutionId === user.institutionId)
          .map((e) => e.classSectionId),
      );
      return sections
        .filter((s) => active.has(s.classSectionId))
        .map((s) => s.classSectionId)
        .sort();
    }
    case 'professor':
      return sections
        .filter((s) => user.professorId !== null && s.professorId === user.professorId)
        .map((s) => s.classSectionId)
        .sort();
    case 'group_executive':
      return [];
    case 'coordinator':
    case 'admin':
      return sections.map((s) => s.classSectionId).sort();
  }
}
