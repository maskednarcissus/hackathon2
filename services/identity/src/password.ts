import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** Contract §2: N = 2^15, r = 8, p = 1, 16-byte salt. */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    // scrypt needs ~128·N·r bytes; leave headroom.
    maxmem: 256 * params.N * params.r,
  };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Format: scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url> */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(password, salt, params);
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (![params.N, params.r, params.p].every((v) => Number.isInteger(v) && v > 0)) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = await derive(password, Buffer.from(saltB64, 'base64url'), params);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Pre-computed hash used when the user does not exist, so that unknown-user and wrong-password
 * responses take comparable time (prevents account enumeration by timing).
 */
export async function createDummyHash(params: ScryptParams): Promise<string> {
  return hashPassword(randomBytes(24).toString('base64url'), params);
}

export const PASSWORD_MIN_LENGTH = 10;
