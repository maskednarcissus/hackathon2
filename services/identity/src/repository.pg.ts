/**
 * PostgreSQL implementations of the identity repositories (integration stage §1).
 * Tables: V003 §6 (users, credentials, refresh tokens, OIDC, login events, access mirrors), V004 §3 (DSR)
 * and data/migrations/pending/identity.sql (refresh grace, event ordering).
 * Parameterised queries only; the service never runs DDL.
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import pg from 'pg';
import {
  DsrError,
  type DsrEvent,
  type DsrRepository,
  type DsrRequest,
  type DsrServiceResult,
  type DsrStatus,
  type DsrType,
} from './dsr.js';
import {
  SecretReferenceRequiredError,
  type AccessMirrorRepository,
  type CredentialRecord,
  type CredentialRepository,
  type EnrollmentMirrorRecord,
  type GraceEntry,
  type InstitutionDirectory,
  type LoginEventRecord,
  type LoginEventRepository,
  type OidcAuthStateRecord,
  type OidcConfigRepository,
  type OidcProviderConfig,
  type OidcStateRepository,
  type RefreshTokenRecord,
  type RefreshTokenRepository,
  type RefreshTokenTx,
  type Repositories,
  type RevokedAccessTokenRepository,
  type SectionMirrorRecord,
  type UserRecord,
  type UserRepository,
} from './repositories.js';

type Row = Record<string, unknown>;
type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';

const date = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : date(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

async function rows(db: Queryable, sql: string, params: unknown[] = []): Promise<Row[]> {
  const result = await db.query(sql, params);
  return result.rows as Row[];
}

async function one(db: Queryable, sql: string, params: unknown[] = []): Promise<Row | undefined> {
  return (await rows(db, sql, params))[0];
}

// ---------------------------------------------------------------------------
// Users & credentials
// ---------------------------------------------------------------------------

const toUser = (r: Row): UserRecord => ({
  id: String(r['id']),
  institutionId: String(r['institution_id']),
  email: String(r['email']),
  name: String(r['name']),
  role: r['role'] as UserRecord['role'],
  studentId: strOrNull(r['student_id']),
  professorId: strOrNull(r['professor_id']),
  holdingCompanyId: strOrNull(r['holding_company_id']),
  status: r['status'] as UserRecord['status'],
  createdAt: date(r['created_at']),
  updatedAt: date(r['updated_at']),
});

class PgUsers implements UserRepository {
  constructor(private readonly db: Queryable) {}

  async create(user: UserRecord): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO users (id, institution_id, email, name, role, student_id, professor_id, status, created_at,
           updated_at, holding_company_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          user.id,
          user.institutionId,
          user.email,
          user.name,
          user.role,
          user.studentId,
          user.professorId,
          user.status,
          user.createdAt,
          user.updatedAt,
          user.holdingCompanyId,
        ],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new Error('duplicate email');
      throw err;
    }
  }

  async update(user: UserRecord): Promise<void> {
    await this.db.query(
      `UPDATE users SET email = $2, name = $3, role = $4, student_id = $5, professor_id = $6, status = $7,
         holding_company_id = $8
       WHERE id = $1`,
      [
        user.id,
        user.email,
        user.name,
        user.role,
        user.studentId,
        user.professorId,
        user.status,
        user.holdingCompanyId,
      ],
    );
  }

  async findById(id: string): Promise<UserRecord | undefined> {
    if (!UUID_RE.test(id)) return undefined;
    const r = await one(this.db, 'SELECT * FROM users WHERE id = $1', [id]);
    return r ? toUser(r) : undefined;
  }

  async findByEmail(institutionId: string, email: string): Promise<UserRecord | undefined> {
    const r = await one(
      this.db,
      'SELECT * FROM users WHERE institution_id = $1 AND lower(email) = lower($2)',
      [institutionId, email.trim()],
    );
    return r ? toUser(r) : undefined;
  }

  async findByPersonId(
    institutionId: string,
    kind: 'student' | 'professor',
    personId: string,
  ): Promise<UserRecord | undefined> {
    if (!UUID_RE.test(personId)) return undefined;
    const column = kind === 'student' ? 'student_id' : 'professor_id';
    const r = await one(
      this.db,
      `SELECT * FROM users WHERE institution_id = $1 AND ${column} = $2 ORDER BY created_at LIMIT 1`,
      [institutionId, personId],
    );
    return r ? toUser(r) : undefined;
  }
}

class PgCredentials implements CredentialRepository {
  constructor(private readonly db: Queryable) {}

  async get(userId: string): Promise<CredentialRecord | undefined> {
    const r = await one(this.db, 'SELECT * FROM user_credentials WHERE user_id = $1', [userId]);
    return r
      ? {
          userId: String(r['user_id']),
          passwordHash: String(r['password_hash']),
          failedAttempts: Number(r['failed_attempts']),
          lockedUntil: dateOrNull(r['locked_until']),
          passwordUpdatedAt: date(r['password_updated_at']),
        }
      : undefined;
  }

  async save(c: CredentialRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO user_credentials (user_id, password_hash, failed_attempts, locked_until, password_updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash,
         failed_attempts = EXCLUDED.failed_attempts, locked_until = EXCLUDED.locked_until,
         password_updated_at = EXCLUDED.password_updated_at`,
      [c.userId, c.passwordHash, c.failedAttempts, c.lockedUntil, c.passwordUpdatedAt],
    );
  }

  async delete(userId: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM user_credentials WHERE user_id = $1', [userId]);
    return (result.rowCount ?? 0) > 0;
  }
}

// ---------------------------------------------------------------------------
// Refresh tokens (rotation under row lock) & grace window
// ---------------------------------------------------------------------------

const toRefresh = (r: Row): RefreshTokenRecord => ({
  id: String(r['id']),
  tokenHash: String(r['token_hash']).trim(),
  familyId: String(r['family_id']),
  userId: String(r['user_id']),
  institutionId: String(r['institution_id']),
  issuedAt: date(r['issued_at']),
  expiresAt: date(r['expires_at']),
  usedAt: dateOrNull(r['used_at']),
  revokedAt: dateOrNull(r['revoked_at']),
  replacedById: strOrNull(r['replaced_by_id']),
});

/** AES-256-GCM sealing of grace-window session pairs; AAD binds the payload to its token row. */
export class GraceCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Refresh grace key must be 32 bytes');
  }

  /** Derives the key from the identity signing key (HKDF-SHA256) when no explicit key is configured. */
  static fromSigningKey(privateKey: KeyObject): GraceCipher {
    const ikm = privateKey.export({ format: 'der', type: 'pkcs8' });
    const key = hkdfSync('sha256', ikm, Buffer.alloc(0), 'ci-identity refresh-grace v1', 32);
    return new GraceCipher(Buffer.from(key));
  }

  seal(aad: string, plaintext: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  }

  open(aad: string, payload: Buffer): string | undefined {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, payload.subarray(0, 12));
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(payload.subarray(12, 28));
      return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
    } catch {
      return undefined;
    }
  }
}

class PgRefreshTokenOps implements RefreshTokenTx {
  constructor(
    protected readonly db: Queryable,
    protected readonly cipher: GraceCipher,
  ) {}

  async create(t: RefreshTokenRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO refresh_tokens (id, token_hash, family_id, user_id, institution_id, issued_at, expires_at,
         used_at, revoked_at, replaced_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        t.id,
        t.tokenHash,
        t.familyId,
        t.userId,
        t.institutionId,
        t.issuedAt,
        t.expiresAt,
        t.usedAt,
        t.revokedAt,
        t.replacedById,
      ],
    );
  }

  async update(t: RefreshTokenRecord): Promise<void> {
    await this.db.query(
      'UPDATE refresh_tokens SET used_at = $2, revoked_at = $3, replaced_by_id = $4 WHERE id = $1',
      [t.id, t.usedAt, t.revokedAt, t.replacedById],
    );
  }

  async findById(id: string): Promise<RefreshTokenRecord | undefined> {
    const r = await one(this.db, 'SELECT * FROM refresh_tokens WHERE id = $1', [id]);
    return r ? toRefresh(r) : undefined;
  }

  async revokeFamily(familyId: string, at: Date): Promise<number> {
    const result = await this.db.query(
      'UPDATE refresh_tokens SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL',
      [familyId, at],
    );
    return result.rowCount ?? 0;
  }

  async putGrace(previousTokenId: string, entry: GraceEntry): Promise<void> {
    const payload = this.cipher.seal(previousTokenId, JSON.stringify(entry.session));
    await this.db.query('DELETE FROM refresh_token_grace WHERE expires_at < $1', [
      new Date(entry.expiresAt.getTime() - 60_000),
    ]);
    await this.db.query(
      `INSERT INTO refresh_token_grace (previous_token_id, successor_id, payload, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (previous_token_id) DO UPDATE SET successor_id = EXCLUDED.successor_id,
         payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at`,
      [previousTokenId, entry.successorId, payload, entry.expiresAt],
    );
  }

  async getGrace(previousTokenId: string, now: Date): Promise<GraceEntry | undefined> {
    const r = await one(
      this.db,
      'SELECT * FROM refresh_token_grace WHERE previous_token_id = $1 AND expires_at >= $2',
      [previousTokenId, now],
    );
    if (!r) return undefined;
    const plaintext = this.cipher.open(previousTokenId, r['payload'] as Buffer);
    if (plaintext === undefined) return undefined;
    return {
      successorId: String(r['successor_id']),
      session: JSON.parse(plaintext) as GraceEntry['session'],
      expiresAt: date(r['expires_at']),
    };
  }

  async deleteGrace(previousTokenId: string): Promise<void> {
    await this.db.query('DELETE FROM refresh_token_grace WHERE previous_token_id = $1', [
      previousTokenId,
    ]);
  }
}

class PgRefreshTokens extends PgRefreshTokenOps implements RefreshTokenRepository {
  constructor(
    private readonly pool: pg.Pool,
    cipher: GraceCipher,
  ) {
    super(pool, cipher);
  }

  async withLockedToken<T>(
    tokenHash: string,
    fn: (record: RefreshTokenRecord | undefined, tx: RefreshTokenTx) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await one(client, 'SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE', [
        tokenHash,
      ]);
      const result = await fn(
        r ? toRefresh(r) : undefined,
        new PgRefreshTokenOps(client, this.cipher),
      );
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | undefined> {
    const r = await one(this.db, 'SELECT * FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
    return r ? toRefresh(r) : undefined;
  }

  async revokeAllForUser(userId: string, at: Date): Promise<number> {
    const result = await this.db.query(
      'UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL',
      [userId, at],
    );
    return result.rowCount ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Access mirror
// ---------------------------------------------------------------------------

const toEnrollment = (r: Row): EnrollmentMirrorRecord => ({
  institutionId: String(r['institution_id']),
  studentId: String(r['student_id']),
  classSectionId: String(r['class_section_id']),
  status: r['status'] as EnrollmentMirrorRecord['status'],
  syncedAt: date(r['synced_at']),
});

const toSection = (r: Row): SectionMirrorRecord => ({
  institutionId: String(r['institution_id']),
  classSectionId: String(r['class_section_id']),
  professorId: strOrNull(r['professor_id']),
  courseId: strOrNull(r['course_id']),
  syncedAt: date(r['synced_at']),
});

class PgAccessMirror implements AccessMirrorRepository {
  constructor(private readonly db: Queryable) {}

  async upsertEnrollment(e: EnrollmentMirrorRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO enrollment_access_mirror (student_id, class_section_id, institution_id, status, synced_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (student_id, class_section_id) DO UPDATE SET institution_id = EXCLUDED.institution_id,
         status = EXCLUDED.status, synced_at = EXCLUDED.synced_at`,
      [e.studentId, e.classSectionId, e.institutionId, e.status, e.syncedAt],
    );
  }

  async findEnrollment(
    studentId: string,
    classSectionId: string,
  ): Promise<EnrollmentMirrorRecord | undefined> {
    const r = await one(
      this.db,
      'SELECT * FROM enrollment_access_mirror WHERE student_id = $1 AND class_section_id = $2',
      [studentId, classSectionId],
    );
    return r ? toEnrollment(r) : undefined;
  }

  async listEnrollmentsBySection(classSectionId: string): Promise<EnrollmentMirrorRecord[]> {
    return (
      await rows(this.db, 'SELECT * FROM enrollment_access_mirror WHERE class_section_id = $1', [
        classSectionId,
      ])
    ).map(toEnrollment);
  }

  async listEnrollmentsByStudent(studentId: string): Promise<EnrollmentMirrorRecord[]> {
    return (
      await rows(this.db, 'SELECT * FROM enrollment_access_mirror WHERE student_id = $1', [
        studentId,
      ])
    ).map(toEnrollment);
  }

  async upsertSection(s: SectionMirrorRecord): Promise<void> {
    // course_name / section_code are descriptive columns other sync paths may fill: left untouched here.
    await this.db.query(
      `INSERT INTO section_access_mirror (class_section_id, institution_id, course_id, professor_id, synced_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (class_section_id) DO UPDATE SET institution_id = EXCLUDED.institution_id,
         course_id = EXCLUDED.course_id, professor_id = EXCLUDED.professor_id, synced_at = EXCLUDED.synced_at`,
      [s.classSectionId, s.institutionId, s.courseId, s.professorId, s.syncedAt],
    );
  }

  async findSection(classSectionId: string): Promise<SectionMirrorRecord | undefined> {
    if (!UUID_RE.test(classSectionId)) return undefined;
    const r = await one(
      this.db,
      'SELECT * FROM section_access_mirror WHERE class_section_id = $1',
      [classSectionId],
    );
    return r ? toSection(r) : undefined;
  }

  async listSectionsByInstitution(institutionId: string): Promise<SectionMirrorRecord[]> {
    return (
      await rows(this.db, 'SELECT * FROM section_access_mirror WHERE institution_id = $1', [
        institutionId,
      ])
    ).map(toSection);
  }
}

// ---------------------------------------------------------------------------
// OIDC, revoked access tokens, login events
// ---------------------------------------------------------------------------

class PgOidcConfigs implements OidcConfigRepository {
  constructor(private readonly db: Queryable) {}

  async get(institutionId: string): Promise<OidcProviderConfig | undefined> {
    const r = await one(
      this.db,
      'SELECT * FROM identity_provider_configs WHERE institution_id = $1',
      [institutionId],
    );
    if (!r) return undefined;
    return {
      institutionId: String(r['institution_id']),
      issuer: String(r['issuer']),
      authorizationEndpoint: String(r['authorization_endpoint']),
      tokenEndpoint: String(r['token_endpoint']),
      jwksUri: String(r['jwks_uri']),
      clientId: String(r['client_id']),
      clientSecret: null, // resolved from the reference by the provider registry
      clientSecretRef: String(r['client_secret_ref']),
      redirectUri: String(r['redirect_uri']),
      scopes: r['scopes'] as string[],
      createdAt: date(r['created_at']),
      updatedAt: date(r['updated_at']),
    };
  }

  async save(c: OidcProviderConfig): Promise<void> {
    if (c.clientSecret !== null && c.clientSecretRef === null)
      throw new SecretReferenceRequiredError();
    await this.db.query(
      `INSERT INTO identity_provider_configs (institution_id, issuer, authorization_endpoint, token_endpoint,
         jwks_uri, client_id, client_secret_ref, redirect_uri, scopes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (institution_id) DO UPDATE SET issuer = EXCLUDED.issuer,
         authorization_endpoint = EXCLUDED.authorization_endpoint, token_endpoint = EXCLUDED.token_endpoint,
         jwks_uri = EXCLUDED.jwks_uri, client_id = EXCLUDED.client_id,
         client_secret_ref = EXCLUDED.client_secret_ref, redirect_uri = EXCLUDED.redirect_uri,
         scopes = EXCLUDED.scopes, updated_at = EXCLUDED.updated_at`,
      [
        c.institutionId,
        c.issuer,
        c.authorizationEndpoint,
        c.tokenEndpoint,
        c.jwksUri,
        c.clientId,
        c.clientSecretRef ?? 'none',
        c.redirectUri,
        c.scopes,
        c.createdAt,
        c.updatedAt,
      ],
    );
  }
}

class PgOidcStates implements OidcStateRepository {
  constructor(private readonly db: Queryable) {}

  async save(s: OidcAuthStateRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO oidc_auth_states (state, institution_id, code_verifier, nonce, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [s.state, s.institutionId, s.codeVerifier, s.nonce, s.createdAt, s.expiresAt],
    );
  }

  /** Single use: the DELETE … RETURNING makes concurrent callbacks with the same state race-free. */
  async consume(state: string): Promise<OidcAuthStateRecord | undefined> {
    const r = await one(this.db, 'DELETE FROM oidc_auth_states WHERE state = $1 RETURNING *', [
      state,
    ]);
    return r
      ? {
          state: String(r['state']),
          institutionId: String(r['institution_id']),
          codeVerifier: String(r['code_verifier']),
          nonce: String(r['nonce']),
          createdAt: date(r['created_at']),
          expiresAt: date(r['expires_at']),
        }
      : undefined;
  }
}

class PgRevokedAccessTokens implements RevokedAccessTokenRepository {
  constructor(private readonly db: Queryable) {}

  async revoke(jti: string, expiresAt: Date): Promise<void> {
    if (!UUID_RE.test(jti)) return;
    await this.db.query(
      'INSERT INTO revoked_access_tokens (jti, expires_at) VALUES ($1, $2) ON CONFLICT (jti) DO NOTHING',
      [jti, expiresAt],
    );
  }

  async isRevoked(jti: string, now: Date): Promise<boolean> {
    if (!UUID_RE.test(jti)) return false;
    const r = await one(
      this.db,
      'SELECT 1 FROM revoked_access_tokens WHERE jti = $1 AND expires_at >= $2',
      [jti, now],
    );
    return r !== undefined;
  }
}

class PgLoginEvents implements LoginEventRepository {
  constructor(private readonly db: Queryable) {}

  async record(e: LoginEventRecord): Promise<void> {
    await this.db.query(
      'INSERT INTO login_events (user_id, institution_id, at, method, outcome) VALUES ($1, $2, $3, $4, $5)',
      [e.userId, e.institutionId, e.at, e.method, e.outcome],
    );
  }

  async listByUser(userId: string): Promise<LoginEventRecord[]> {
    return (
      await rows(this.db, 'SELECT * FROM login_events WHERE user_id = $1 ORDER BY at', [userId])
    ).map((r) => ({
      userId: String(r['user_id']),
      institutionId: String(r['institution_id']),
      at: date(r['at']),
      method: r['method'] as LoginEventRecord['method'],
      outcome: r['outcome'] as LoginEventRecord['outcome'],
    }));
  }

  async deleteByUser(userId: string): Promise<number> {
    const result = await this.db.query('DELETE FROM login_events WHERE user_id = $1', [userId]);
    return result.rowCount ?? 0;
  }
}

export interface PgRepositoryOptions {
  /** Seals refresh-grace session pairs at rest. */
  graceCipher: GraceCipher;
}

export function createPgRepositories(pool: pg.Pool, options: PgRepositoryOptions): Repositories {
  return {
    users: new PgUsers(pool),
    credentials: new PgCredentials(pool),
    refreshTokens: new PgRefreshTokens(pool, options.graceCipher),
    access: new PgAccessMirror(pool),
    oidcConfigs: new PgOidcConfigs(pool),
    oidcStates: new PgOidcStates(pool),
    revokedAccessTokens: new PgRevokedAccessTokens(pool),
    loginEvents: new PgLoginEvents(pool),
  };
}

// ---------------------------------------------------------------------------
// DSR
// ---------------------------------------------------------------------------

const toDsr = (r: Row): DsrRequest => {
  const details = r['details'] as Record<string, unknown> | null;
  return {
    id: String(r['id']),
    institutionId: String(r['institution_id']),
    subjectType: r['subject_type'] as DsrRequest['subjectType'],
    subjectId: String(r['subject_id']),
    subjectUserId: String(r['subject_user_id']),
    type: r['type'] as DsrType,
    status: r['status'] as DsrStatus,
    requestedBy: String(r['requested_by']),
    channel: r['channel'] as DsrRequest['channel'],
    details: details && Object.keys(details).length > 0 ? details : null,
    receivedAt: date(r['received_at']),
    dueAt: date(r['due_at']),
    verifiedAt: dateOrNull(r['verified_at']),
    verifiedBy: strOrNull(r['verified_by']),
    verificationMethod: strOrNull(r['verification_method']),
    completedAt: dateOrNull(r['completed_at']),
    rejectedAt: dateOrNull(r['rejected_at']),
    rejectionReason: strOrNull(r['rejection_reason']),
    exportUri: strOrNull(r['export_uri']),
    executionAttempts: Number(r['execution_attempts']),
    updatedAt: date(r['updated_at']),
  };
};

const toResult = (r: Row): DsrServiceResult => ({
  requestId: String(r['request_id']),
  service: String(r['service']),
  status: r['status'] as DsrServiceResult['status'],
  attempts: Number(r['attempts']),
  items: r['items'],
  exportUri: strOrNull(r['export_uri']),
  error: strOrNull(r['error']),
  lastAttemptAt: dateOrNull(r['last_attempt_at']),
  completedAt: dateOrNull(r['completed_at']),
});

export class PgDsrRepository implements DsrRepository {
  constructor(private readonly db: Queryable) {}

  async create(d: DsrRequest): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO dsr_requests (id, institution_id, subject_type, subject_id, subject_user_id, type, status,
           requested_by, channel, details, received_at, due_at, verified_at, verified_by, verification_method,
           completed_at, rejected_at, rejection_reason, export_uri, execution_attempts, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
        [
          d.id,
          d.institutionId,
          d.subjectType,
          d.subjectId,
          d.subjectUserId,
          d.type,
          d.status,
          d.requestedBy,
          d.channel,
          JSON.stringify(d.details ?? {}),
          d.receivedAt,
          d.dueAt,
          d.verifiedAt,
          d.verifiedBy,
          d.verificationMethod,
          d.completedAt,
          d.rejectedAt,
          d.rejectionReason,
          d.exportUri,
          d.executionAttempts,
          d.updatedAt,
        ],
      );
    } catch (err) {
      // uq_dsr_requests_open: a concurrent create for the same subject and type won the race.
      if (isUniqueViolation(err)) {
        throw new DsrError(409, 'dsr_already_open', `An open ${d.type} request already exists`);
      }
      throw err;
    }
  }

  async update(d: DsrRequest): Promise<void> {
    await this.db.query(
      `UPDATE dsr_requests SET status = $2, verified_at = $3, verified_by = $4, verification_method = $5,
         completed_at = $6, rejected_at = $7, rejection_reason = $8, export_uri = $9, execution_attempts = $10
       WHERE id = $1`,
      [
        d.id,
        d.status,
        d.verifiedAt,
        d.verifiedBy,
        d.verificationMethod,
        d.completedAt,
        d.rejectedAt,
        d.rejectionReason,
        d.exportUri,
        d.executionAttempts,
      ],
    );
  }

  async get(id: string): Promise<DsrRequest | undefined> {
    if (!UUID_RE.test(id)) return undefined;
    const r = await one(this.db, 'SELECT * FROM dsr_requests WHERE id = $1', [id]);
    return r ? toDsr(r) : undefined;
  }

  async list(filter: { institutionId?: string; status?: DsrStatus }): Promise<DsrRequest[]> {
    return (
      await rows(
        this.db,
        `SELECT * FROM dsr_requests
         WHERE ($1::uuid IS NULL OR institution_id = $1) AND ($2::dsr_status IS NULL OR status = $2)
         ORDER BY due_at, received_at`,
        [filter.institutionId ?? null, filter.status ?? null],
      )
    ).map(toDsr);
  }

  async findOpen(
    institutionId: string,
    subjectUserId: string,
    type: DsrType,
  ): Promise<DsrRequest | undefined> {
    const r = await one(
      this.db,
      `SELECT * FROM dsr_requests WHERE institution_id = $1 AND subject_user_id = $2 AND type = $3
         AND status IN ('received', 'verifying', 'in_progress') LIMIT 1`,
      [institutionId, subjectUserId, type],
    );
    return r ? toDsr(r) : undefined;
  }

  async upsertResult(x: DsrServiceResult): Promise<void> {
    await this.db.query(
      `INSERT INTO dsr_service_results (request_id, service, status, attempts, items, export_uri, error,
         last_attempt_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (request_id, service) DO UPDATE SET status = EXCLUDED.status, attempts = EXCLUDED.attempts,
         items = EXCLUDED.items, export_uri = EXCLUDED.export_uri, error = EXCLUDED.error,
         last_attempt_at = EXCLUDED.last_attempt_at, completed_at = EXCLUDED.completed_at`,
      [
        x.requestId,
        x.service,
        x.status,
        x.attempts,
        JSON.stringify(x.items ?? null),
        x.exportUri,
        x.error,
        x.lastAttemptAt,
        x.completedAt,
      ],
    );
  }

  async listResults(requestId: string): Promise<DsrServiceResult[]> {
    return (
      await rows(
        this.db,
        'SELECT * FROM dsr_service_results WHERE request_id = $1 ORDER BY service',
        [requestId],
      )
    ).map(toResult);
  }

  async addEvent(e: DsrEvent): Promise<void> {
    await this.db.query(
      'INSERT INTO dsr_events (id, request_id, at, type, actor_id, details) VALUES ($1, $2, $3, $4, $5, $6)',
      [
        e.id,
        e.requestId,
        e.at,
        e.type,
        e.actorId !== null && UUID_RE.test(e.actorId) ? e.actorId : null,
        JSON.stringify(e.details ?? {}),
      ],
    );
  }

  async listEvents(requestId: string): Promise<DsrEvent[]> {
    return (
      await rows(this.db, 'SELECT * FROM dsr_events WHERE request_id = $1 ORDER BY at, seq', [
        requestId,
      ])
    ).map((r) => {
      const details = r['details'] as Record<string, unknown> | null;
      return {
        id: String(r['id']),
        requestId: String(r['request_id']),
        at: date(r['at']),
        type: r['type'] as DsrEvent['type'],
        actorId: strOrNull(r['actor_id']),
        details: details && Object.keys(details).length > 0 ? details : null,
      };
    });
  }
}

/** Reads the organisation hierarchy root (institutions → holding company); read-only. */
export class PgInstitutionDirectory implements InstitutionDirectory {
  constructor(private readonly db: Queryable) {}
  async holdingCompanyOf(institutionId: string): Promise<string | undefined> {
    if (!UUID_RE.test(institutionId)) return undefined;
    const r = await one(this.db, 'SELECT holding_company_id FROM institutions WHERE id = $1', [
      institutionId,
    ]);
    return r ? String(r['holding_company_id']) : undefined;
  }
}
