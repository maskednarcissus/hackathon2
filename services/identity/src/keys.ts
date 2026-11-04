import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import { keyIdFor } from './jwt-verify.js';

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export interface PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  use: 'sig';
  alg: 'EdDSA';
}

export function signingKeyFromPrivateKey(privateKey: KeyObject): SigningKey {
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Identity signing key must be an Ed25519 private key');
  }
  const publicKey = createPublicKey(privateKey);
  return { kid: keyIdFor(publicKey), privateKey, publicKey };
}

export function generateSigningKey(): SigningKey {
  const { privateKey } = generateKeyPairSync('ed25519');
  return signingKeyFromPrivateKey(privateKey);
}

export interface LoadedSigningKey {
  key: SigningKey;
  ephemeral: boolean;
}

/** Loads the signing key from PEM (IDENTITY_SIGNING_KEY_PEM) or generates an ephemeral dev key. */
export function loadSigningKey(pem: string | undefined): LoadedSigningKey {
  if (pem && pem.trim().length > 0) {
    return {
      key: signingKeyFromPrivateKey(createPrivateKey(pem.replace(/\\n/g, '\n'))),
      ephemeral: false,
    };
  }
  return { key: generateSigningKey(), ephemeral: true };
}

export class KeyStore {
  private readonly verificationKeys = new Map<string, KeyObject>();

  /**
   * @param active key used to sign new tokens
   * @param previousPublicKeys keys still accepted for verification during rotation
   */
  constructor(
    public readonly active: SigningKey,
    previousPublicKeys: readonly KeyObject[] = [],
  ) {
    this.verificationKeys.set(active.kid, active.publicKey);
    for (const key of previousPublicKeys) {
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('Verification keys must be Ed25519');
      this.verificationKeys.set(keyIdFor(key), key);
    }
  }

  sign(data: Buffer): Buffer {
    return cryptoSign(null, data, this.active.privateKey);
  }

  getPublicKey(kid: string | undefined): KeyObject | undefined {
    return kid === undefined ? undefined : this.verificationKeys.get(kid);
  }

  jwks(): { keys: PublicJwk[] } {
    return {
      keys: [...this.verificationKeys.entries()].map(([kid, key]) => {
        const jwk = key.export({ format: 'jwk' });
        return { kty: 'OKP', crv: 'Ed25519', x: String(jwk.x), kid, use: 'sig', alg: 'EdDSA' };
      }),
    };
  }
}
