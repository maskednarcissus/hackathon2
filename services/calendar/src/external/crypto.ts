/** AES-256-GCM sealing of provider OAuth tokens (Phase 6 §6.9). AAD binds a ciphertext to its connection. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class TokenCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('CALENDAR_TOKEN_KEY must be 32 bytes (base64)');
  }

  /**
   * `CALENDAR_TOKEN_KEY` (base64) or `CALENDAR_TOKEN_KEY_REF` (`env:NAME`, resolved from the environment,
   * populated from Secret Manager in production).
   */
  static fromEnv(env: NodeJS.ProcessEnv): TokenCipher | undefined {
    const ref = env['CALENDAR_TOKEN_KEY_REF'];
    const value = ref?.startsWith('env:') ? env[ref.slice(4)] : env['CALENDAR_TOKEN_KEY'];
    return value ? new TokenCipher(Buffer.from(value, 'base64')) : undefined;
  }

  static ephemeral(): TokenCipher {
    return new TokenCipher(randomBytes(32));
  }

  seal(aad: string, plaintext: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  }

  /** Throws when the payload was tampered with, belongs to another connection or another key. */
  open(aad: string, payload: Buffer): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, payload.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(payload.subarray(12, 28));
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString(
      'utf8',
    );
  }
}
