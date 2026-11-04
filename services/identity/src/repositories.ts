import type { Role } from './jwt-verify.js';

export type UserStatus = 'active' | 'disabled';
export type EnrollmentStatus = 'active' | 'withdrawn' | 'completed';

export interface UserRecord {
  id: string;
  institutionId: string;
  /** Always stored lower-cased and trimmed. */
  email: string;
  name: string;
  role: Role;
  studentId: string | null;
  professorId: string | null;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CredentialRecord {
  userId: string;
  passwordHash: string;
  failedAttempts: number;
  lockedUntil: Date | null;
  passwordUpdatedAt: Date;
}

export interface RefreshTokenRecord {
  id: string;
  /** SHA-256 hex of the opaque token; the token itself is never stored. */
  tokenHash: string;
  familyId: string;
  userId: string;
  institutionId: string;
  issuedAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  replacedById: string | null;
}

export interface EnrollmentMirrorRecord {
  institutionId: string;
  studentId: string;
  classSectionId: string;
  status: EnrollmentStatus;
  syncedAt: Date;
}

export interface SectionMirrorRecord {
  institutionId: string;
  classSectionId: string;
  professorId: string | null;
  courseId: string | null;
  syncedAt: Date;
}

export interface OidcProviderConfig {
  institutionId: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  clientId: string;
  /** Resolved secret value (from Secret Manager in production). */
  clientSecret: string | null;
  redirectUri: string;
  scopes: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface OidcAuthStateRecord {
  state: string;
  institutionId: string;
  codeVerifier: string;
  nonce: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface UserRepository {
  create(user: UserRecord): Promise<void>;
  update(user: UserRecord): Promise<void>;
  findById(id: string): Promise<UserRecord | undefined>;
  findByEmail(institutionId: string, email: string): Promise<UserRecord | undefined>;
  /** Finds the account linked to an academic person (studentId / professorId) in the institution. */
  findByPersonId(
    institutionId: string,
    kind: 'student' | 'professor',
    personId: string,
  ): Promise<UserRecord | undefined>;
}

export interface CredentialRepository {
  get(userId: string): Promise<CredentialRecord | undefined>;
  save(record: CredentialRecord): Promise<void>;
  /** Returns true when a credential existed. */
  delete(userId: string): Promise<boolean>;
}

export interface RefreshTokenRepository {
  create(record: RefreshTokenRecord): Promise<void>;
  update(record: RefreshTokenRecord): Promise<void>;
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | undefined>;
  findById(id: string): Promise<RefreshTokenRecord | undefined>;
  /** Revokes every non-revoked token of the family; returns how many were revoked. */
  revokeFamily(familyId: string, at: Date): Promise<number>;
  /** Revokes every non-revoked token of the user; returns how many were revoked. */
  revokeAllForUser(userId: string, at: Date): Promise<number>;
}

export interface LoginEventRecord {
  userId: string;
  institutionId: string;
  at: Date;
  method: 'password' | 'oidc';
  outcome: 'succeeded' | 'failed';
}

export interface LoginEventRepository {
  record(event: LoginEventRecord): Promise<void>;
  listByUser(userId: string): Promise<LoginEventRecord[]>;
  deleteByUser(userId: string): Promise<number>;
}

export interface AccessMirrorRepository {
  upsertEnrollment(record: EnrollmentMirrorRecord): Promise<void>;
  findEnrollment(
    studentId: string,
    classSectionId: string,
  ): Promise<EnrollmentMirrorRecord | undefined>;
  listEnrollmentsBySection(classSectionId: string): Promise<EnrollmentMirrorRecord[]>;
  listEnrollmentsByStudent(studentId: string): Promise<EnrollmentMirrorRecord[]>;
  upsertSection(record: SectionMirrorRecord): Promise<void>;
  findSection(classSectionId: string): Promise<SectionMirrorRecord | undefined>;
  listSectionsByInstitution(institutionId: string): Promise<SectionMirrorRecord[]>;
}

export interface OidcConfigRepository {
  get(institutionId: string): Promise<OidcProviderConfig | undefined>;
  save(config: OidcProviderConfig): Promise<void>;
}

export interface OidcStateRepository {
  save(record: OidcAuthStateRecord): Promise<void>;
  /** Returns and deletes the state (single use). */
  consume(state: string): Promise<OidcAuthStateRecord | undefined>;
}

export interface RevokedAccessTokenRepository {
  revoke(jti: string, expiresAt: Date): Promise<void>;
  isRevoked(jti: string, now: Date): Promise<boolean>;
}

export interface Repositories {
  users: UserRepository;
  credentials: CredentialRepository;
  refreshTokens: RefreshTokenRepository;
  access: AccessMirrorRepository;
  oidcConfigs: OidcConfigRepository;
  oidcStates: OidcStateRepository;
  revokedAccessTokens: RevokedAccessTokenRepository;
  loginEvents: LoginEventRepository;
}

const clone = <T>(value: T): T => structuredClone(value);

class InMemoryUsers implements UserRepository {
  private readonly byId = new Map<string, UserRecord>();
  async create(user: UserRecord): Promise<void> {
    if (await this.findByEmail(user.institutionId, user.email)) throw new Error('duplicate email');
    this.byId.set(user.id, clone(user));
  }
  async update(user: UserRecord): Promise<void> {
    this.byId.set(user.id, clone(user));
  }
  async findById(id: string): Promise<UserRecord | undefined> {
    const u = this.byId.get(id);
    return u ? clone(u) : undefined;
  }
  async findByPersonId(
    institutionId: string,
    kind: 'student' | 'professor',
    personId: string,
  ): Promise<UserRecord | undefined> {
    for (const u of this.byId.values()) {
      if (u.institutionId !== institutionId) continue;
      if ((kind === 'student' ? u.studentId : u.professorId) === personId) return clone(u);
    }
    return undefined;
  }
  async findByEmail(institutionId: string, email: string): Promise<UserRecord | undefined> {
    const needle = email.trim().toLowerCase();
    for (const u of this.byId.values()) {
      if (u.institutionId === institutionId && u.email === needle) return clone(u);
    }
    return undefined;
  }
}

class InMemoryCredentials implements CredentialRepository {
  private readonly items = new Map<string, CredentialRecord>();
  async get(userId: string): Promise<CredentialRecord | undefined> {
    const c = this.items.get(userId);
    return c ? clone(c) : undefined;
  }
  async save(record: CredentialRecord): Promise<void> {
    this.items.set(record.userId, clone(record));
  }
  async delete(userId: string): Promise<boolean> {
    return this.items.delete(userId);
  }
}

class InMemoryRefreshTokens implements RefreshTokenRepository {
  private readonly items = new Map<string, RefreshTokenRecord>();
  async create(record: RefreshTokenRecord): Promise<void> {
    this.items.set(record.id, clone(record));
  }
  async update(record: RefreshTokenRecord): Promise<void> {
    this.items.set(record.id, clone(record));
  }
  async findById(id: string): Promise<RefreshTokenRecord | undefined> {
    const r = this.items.get(id);
    return r ? clone(r) : undefined;
  }
  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | undefined> {
    for (const r of this.items.values()) if (r.tokenHash === tokenHash) return clone(r);
    return undefined;
  }
  async revokeAllForUser(userId: string, at: Date): Promise<number> {
    let count = 0;
    for (const r of this.items.values()) {
      if (r.userId === userId && r.revokedAt === null) {
        r.revokedAt = at;
        count += 1;
      }
    }
    return count;
  }
  async revokeFamily(familyId: string, at: Date): Promise<number> {
    let count = 0;
    for (const r of this.items.values()) {
      if (r.familyId === familyId && r.revokedAt === null) {
        r.revokedAt = at;
        count += 1;
      }
    }
    return count;
  }
}

class InMemoryAccessMirror implements AccessMirrorRepository {
  private readonly enrollments = new Map<string, EnrollmentMirrorRecord>();
  private readonly sections = new Map<string, SectionMirrorRecord>();
  private static key(studentId: string, sectionId: string): string {
    return `${studentId}:${sectionId}`;
  }
  async upsertEnrollment(record: EnrollmentMirrorRecord): Promise<void> {
    this.enrollments.set(
      InMemoryAccessMirror.key(record.studentId, record.classSectionId),
      clone(record),
    );
  }
  async findEnrollment(
    studentId: string,
    classSectionId: string,
  ): Promise<EnrollmentMirrorRecord | undefined> {
    const e = this.enrollments.get(InMemoryAccessMirror.key(studentId, classSectionId));
    return e ? clone(e) : undefined;
  }
  async listEnrollmentsBySection(classSectionId: string): Promise<EnrollmentMirrorRecord[]> {
    return [...this.enrollments.values()]
      .filter((e) => e.classSectionId === classSectionId)
      .map(clone);
  }
  async listEnrollmentsByStudent(studentId: string): Promise<EnrollmentMirrorRecord[]> {
    return [...this.enrollments.values()].filter((e) => e.studentId === studentId).map(clone);
  }
  async upsertSection(record: SectionMirrorRecord): Promise<void> {
    this.sections.set(record.classSectionId, clone(record));
  }
  async findSection(classSectionId: string): Promise<SectionMirrorRecord | undefined> {
    const s = this.sections.get(classSectionId);
    return s ? clone(s) : undefined;
  }
  async listSectionsByInstitution(institutionId: string): Promise<SectionMirrorRecord[]> {
    return [...this.sections.values()].filter((s) => s.institutionId === institutionId).map(clone);
  }
}

class InMemoryOidcConfigs implements OidcConfigRepository {
  private readonly items = new Map<string, OidcProviderConfig>();
  async get(institutionId: string): Promise<OidcProviderConfig | undefined> {
    const c = this.items.get(institutionId);
    return c ? clone(c) : undefined;
  }
  async save(config: OidcProviderConfig): Promise<void> {
    this.items.set(config.institutionId, clone(config));
  }
}

class InMemoryOidcStates implements OidcStateRepository {
  private readonly items = new Map<string, OidcAuthStateRecord>();
  async save(record: OidcAuthStateRecord): Promise<void> {
    this.items.set(record.state, clone(record));
  }
  async consume(state: string): Promise<OidcAuthStateRecord | undefined> {
    const record = this.items.get(state);
    this.items.delete(state);
    return record;
  }
}

class InMemoryRevokedAccessTokens implements RevokedAccessTokenRepository {
  private readonly items = new Map<string, Date>();
  async revoke(jti: string, expiresAt: Date): Promise<void> {
    this.items.set(jti, expiresAt);
  }
  async isRevoked(jti: string, now: Date): Promise<boolean> {
    const exp = this.items.get(jti);
    if (!exp) return false;
    if (exp.getTime() < now.getTime()) {
      this.items.delete(jti);
      return false;
    }
    return true;
  }
}

class InMemoryLoginEvents implements LoginEventRepository {
  private items: LoginEventRecord[] = [];
  async record(event: LoginEventRecord): Promise<void> {
    this.items.push(clone(event));
  }
  async listByUser(userId: string): Promise<LoginEventRecord[]> {
    return this.items.filter((e) => e.userId === userId).map(clone);
  }
  async deleteByUser(userId: string): Promise<number> {
    const before = this.items.length;
    this.items = this.items.filter((e) => e.userId !== userId);
    return before - this.items.length;
  }
}

export function createInMemoryRepositories(): Repositories {
  return {
    users: new InMemoryUsers(),
    credentials: new InMemoryCredentials(),
    refreshTokens: new InMemoryRefreshTokens(),
    access: new InMemoryAccessMirror(),
    oidcConfigs: new InMemoryOidcConfigs(),
    oidcStates: new InMemoryOidcStates(),
    revokedAccessTokens: new InMemoryRevokedAccessTokens(),
    loginEvents: new InMemoryLoginEvents(),
  };
}
