import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  createAccessTokenVerifier,
  type AccessTokenClaims,
  type AccessTokenVerifier,
} from './jwt-verify.js';
import type { KeyStore } from './keys.js';
import type { RefreshTokenRecord, Repositories, UserRecord } from './repositories.js';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface TokenConfig {
  issuer: string;
  audience: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type RefreshOutcome =
  | { ok: true; session: IssuedSession; user: UserRecord }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'user_inactive' }
  | { ok: false; reason: 'reuse_detected'; record: RefreshTokenRecord; revokedCount: number };

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export function signAccessToken(keyStore: KeyStore, claims: AccessTokenClaims): string {
  const header = { alg: 'EdDSA', typ: 'JWT', kid: keyStore.active.kid };
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = keyStore.sign(Buffer.from(signingInput, 'utf8')).toString('base64url');
  return `${signingInput}.${signature}`;
}

export class TokenService {
  readonly verifyAccessToken: AccessTokenVerifier;

  constructor(
    private readonly keyStore: KeyStore,
    private readonly repos: Repositories,
    private readonly clock: Clock,
    private readonly config: TokenConfig,
  ) {
    this.verifyAccessToken = createAccessTokenVerifier({
      getKey: (kid) => keyStore.getPublicKey(kid),
      issuer: config.issuer,
      audience: config.audience,
      now: () => clock.now(),
    });
  }

  issueAccessToken(user: UserRecord): { token: string; claims: AccessTokenClaims } {
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    const pid =
      user.role === 'student'
        ? user.studentId
        : user.role === 'professor'
          ? user.professorId
          : null;
    const claims: AccessTokenClaims = {
      iss: this.config.issuer,
      sub: user.id,
      aud: this.config.audience,
      iat,
      exp: iat + this.config.accessTokenTtlSeconds,
      jti: randomUUID(),
      inst: user.institutionId,
      role: user.role,
      ...(pid ? { pid } : {}),
    };
    return { token: signAccessToken(this.keyStore, claims), claims };
  }

  async issueSession(
    user: UserRecord,
    familyId: string = randomUUID(),
  ): Promise<IssuedSession & { refreshRecord: RefreshTokenRecord }> {
    const refreshToken = `rt_${randomBytes(32).toString('base64url')}`;
    const now = this.clock.now();
    const refreshRecord: RefreshTokenRecord = {
      id: randomUUID(),
      tokenHash: hashToken(refreshToken),
      familyId,
      userId: user.id,
      institutionId: user.institutionId,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + this.config.refreshTokenTtlSeconds * 1000),
      usedAt: null,
      revokedAt: null,
      replacedById: null,
    };
    await this.repos.refreshTokens.create(refreshRecord);
    const { token } = this.issueAccessToken(user);
    return {
      accessToken: token,
      refreshToken,
      expiresIn: this.config.accessTokenTtlSeconds,
      refreshRecord,
    };
  }

  /** Rotates a refresh token. Presenting an already-rotated token revokes its whole family. */
  async rotate(refreshToken: string): Promise<RefreshOutcome> {
    const record = await this.repos.refreshTokens.findByHash(hashToken(refreshToken));
    if (!record) return { ok: false, reason: 'unknown' };
    const now = this.clock.now();
    if (record.revokedAt !== null) return { ok: false, reason: 'revoked' };
    if (record.usedAt !== null) {
      const revokedCount = await this.repos.refreshTokens.revokeFamily(record.familyId, now);
      return { ok: false, reason: 'reuse_detected', record, revokedCount };
    }
    if (record.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };

    const user = await this.repos.users.findById(record.userId);
    if (!user || user.status !== 'active') {
      await this.repos.refreshTokens.revokeFamily(record.familyId, now);
      return { ok: false, reason: 'user_inactive' };
    }

    const issued = await this.issueSession(user, record.familyId);
    await this.repos.refreshTokens.update({
      ...record,
      usedAt: now,
      replacedById: issued.refreshRecord.id,
    });
    return {
      ok: true,
      user,
      session: {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        expiresIn: issued.expiresIn,
      },
    };
  }

  async revokeFamilyOf(refreshToken: string): Promise<RefreshTokenRecord | undefined> {
    const record = await this.repos.refreshTokens.findByHash(hashToken(refreshToken));
    if (record) await this.repos.refreshTokens.revokeFamily(record.familyId, this.clock.now());
    return record;
  }
}
