import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  createAccessTokenVerifier,
  type AccessTokenClaims,
  type AccessTokenVerifier,
} from './jwt-verify.js';
import type { KeyStore } from './keys.js';
import type {
  IssuedSession,
  RefreshTokenRecord,
  RefreshTokenTx,
  Repositories,
  UserRecord,
} from './repositories.js';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface TokenConfig {
  issuer: string;
  audience: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  /** Window in which the previous refresh token replays its successor instead of revoking. */
  rotationGraceSeconds: number;
}

export type { IssuedSession } from './repositories.js';

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
  private readonly inflight = new Map<string, Promise<RefreshOutcome>>();

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
      ...(user.role === 'group_executive' && user.holdingCompanyId
        ? { hc: user.holdingCompanyId }
        : {}),
    };
    return { token: signAccessToken(this.keyStore, claims), claims };
  }

  async issueSession(
    user: UserRecord,
    familyId: string = randomUUID(),
    store: Pick<RefreshTokenTx, 'create'> = this.repos.refreshTokens,
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
    await store.create(refreshRecord);
    const { token } = this.issueAccessToken(user);
    return {
      accessToken: token,
      refreshToken,
      expiresIn: this.config.accessTokenTtlSeconds,
      refreshRecord,
    };
  }

  /** Rotates a refresh token. Presenting an already-rotated token revokes its whole family. */
  /**
   * Rotates a refresh token. Presenting an already-rotated token revokes its whole family, except within
   * the grace window: the immediately-previous token, re-presented within `rotationGraceSeconds` of its
   * rotation (concurrent refreshes from the same client), returns the same successor pair without rotating
   * again. Concurrent calls for the same token in this process share one rotation.
   */
  async rotate(refreshToken: string): Promise<RefreshOutcome> {
    const tokenHash = hashToken(refreshToken);
    const running = this.inflight.get(tokenHash);
    if (running) return running;
    const promise = this.rotateOnce(tokenHash).finally(() => this.inflight.delete(tokenHash));
    this.inflight.set(tokenHash, promise);
    return promise;
  }

  private rotateOnce(tokenHash: string): Promise<RefreshOutcome> {
    // The token row stays locked (SELECT … FOR UPDATE in Postgres) for the whole decision, so two
    // replicas rotating the same token serialise: the second one sees `usedAt` and takes the grace path.
    return this.repos.refreshTokens.withLockedToken(tokenHash, async (record, tx) => {
      if (!record) return { ok: false, reason: 'unknown' };
      const now = this.clock.now();
      if (record.revokedAt !== null) return { ok: false, reason: 'revoked' };
      if (record.usedAt !== null) {
        const replay = await this.graceReplay(record, now, tx);
        if (replay) return replay;
        const revokedCount = await tx.revokeFamily(record.familyId, now);
        await tx.deleteGrace(record.id);
        return { ok: false, reason: 'reuse_detected', record, revokedCount };
      }
      if (record.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };

      const user = await this.repos.users.findById(record.userId);
      if (!user || user.status !== 'active') {
        await tx.revokeFamily(record.familyId, now);
        return { ok: false, reason: 'user_inactive' };
      }

      const issued = await this.issueSession(user, record.familyId, tx);
      await tx.update({ ...record, usedAt: now, replacedById: issued.refreshRecord.id });
      const session: IssuedSession = {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        expiresIn: issued.expiresIn,
      };
      const graceMs = this.config.rotationGraceSeconds * 1000;
      if (graceMs > 0) {
        await tx.putGrace(record.id, {
          successorId: issued.refreshRecord.id,
          session,
          expiresAt: new Date(now.getTime() + graceMs),
        });
      }
      return { ok: true, user, session };
    });
  }

  /** Same successor pair if `record` was rotated < grace ago and its successor is still untouched. */
  private async graceReplay(
    record: RefreshTokenRecord,
    now: Date,
    tx: RefreshTokenTx,
  ): Promise<RefreshOutcome | undefined> {
    if (record.usedAt === null || record.replacedById === null) return undefined;
    if (now.getTime() - record.usedAt.getTime() > this.config.rotationGraceSeconds * 1000) {
      return undefined;
    }
    const cached = await tx.getGrace(record.id, now);
    if (!cached || cached.successorId !== record.replacedById) return undefined;
    const successor = await tx.findById(record.replacedById);
    if (!successor || successor.usedAt !== null || successor.revokedAt !== null) return undefined;
    const user = await this.repos.users.findById(record.userId);
    if (!user || user.status !== 'active') return undefined;
    return { ok: true, user, session: cached.session };
  }

  async revokeFamilyOf(refreshToken: string): Promise<RefreshTokenRecord | undefined> {
    const record = await this.repos.refreshTokens.findByHash(hashToken(refreshToken));
    if (record) await this.repos.refreshTokens.revokeFamily(record.familyId, this.clock.now());
    return record;
  }
}
