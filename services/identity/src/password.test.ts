import { describe, expect, it } from 'vitest';
import { DEFAULT_SCRYPT_PARAMS, hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('uses the contract scrypt parameters (N=2^15, r=8, p=1, 16-byte salt) by default', async () => {
    const hash = await hashPassword('senha-super-secreta');
    const [scheme, n, r, p, salt] = hash.split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBe(2 ** 15);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
    expect(Buffer.from(salt ?? '', 'base64url')).toHaveLength(16);
    expect(DEFAULT_SCRYPT_PARAMS).toEqual({ N: 32768, r: 8, p: 1 });
    await expect(verifyPassword('senha-super-secreta', hash)).resolves.toBe(true);
    await expect(verifyPassword('senha-errada', hash)).resolves.toBe(false);
  });

  it('salts every hash', async () => {
    const params = { N: 1024, r: 8, p: 1 };
    expect(await hashPassword('a', params)).not.toBe(await hashPassword('a', params));
  });

  it('rejects malformed stored hashes without throwing', async () => {
    await expect(verifyPassword('x', 'plaintext')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$0$8$1$aaaa$bbbb')).resolves.toBe(false);
  });
});
