import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface FeedTokenRecord {
  studentId: string;
  tokenHash: string; // hex sha256
  createdAt: string;
}

export interface FeedTokenRepository {
  /** Replaces any previous token of the student (rotation invalidates the old one). */
  put(record: FeedTokenRecord): Promise<void>;
  get(studentId: string): Promise<FeedTokenRecord | undefined>;
  /** Removes the student's token (DSR deletion); returns whether one existed. */
  delete(studentId: string): Promise<boolean>;
}

export class InMemoryFeedTokenRepository implements FeedTokenRepository {
  private readonly tokens = new Map<string, FeedTokenRecord>();
  async put(record: FeedTokenRecord): Promise<void> {
    this.tokens.set(record.studentId, { ...record });
  }
  async get(studentId: string): Promise<FeedTokenRecord | undefined> {
    const t = this.tokens.get(studentId);
    return t ? { ...t } : undefined;
  }
  async delete(studentId: string): Promise<boolean> {
    return this.tokens.delete(studentId);
  }
}

const hash = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/** 256-bit random, URL-safe. Only the SHA-256 hash is stored. */
export function generateFeedToken(): { token: string; tokenHash: string } {
  const token = `cft_${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: hash(token).toString('hex') };
}

/** Constant-time comparison of a presented token against the stored hash. */
export function verifyFeedToken(presented: string, storedHashHex: string): boolean {
  const stored = Buffer.from(storedHashHex, 'hex');
  const candidate = hash(presented);
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}
