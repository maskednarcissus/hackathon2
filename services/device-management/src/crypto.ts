import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

export const sha256Hex = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

const b64url = (buf: Buffer): string => buf.toString('base64url');

/** Opaque provisioning token: `pt_` + 32 random bytes (base64url). Only its SHA-256 is persisted. */
export const generateProvisioningToken = (): string => `pt_${b64url(randomBytes(32))}`;

/** Parses a PEM public key and ensures it is Ed25519. Throws on anything else. */
export function parseEd25519PublicKey(pem: string): KeyObject {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Expected an Ed25519 public key, got ${key.asymmetricKeyType ?? 'unknown'}`);
  }
  return key;
}

/** `sha256:<hex>` of the DER-encoded SubjectPublicKeyInfo — stable regardless of PEM formatting. */
export function publicKeyFingerprint(key: KeyObject): string {
  return `sha256:${sha256Hex(key.export({ format: 'der', type: 'spki' }))}`;
}

export const normalizePublicKeyPem = (key: KeyObject): string =>
  key.export({ format: 'pem', type: 'spki' }).toString();

export interface DeviceCertificatePayload {
  v: 1;
  deviceId: string;
  serialNumber: string;
  institutionId: string;
  publicKeyFingerprint: string;
  issuedAt: string;
  expiresAt: string;
  issuer: 'ci-device-ca';
}

export interface DeviceCa {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** True when the key was generated in-process (development only). */
  ephemeral: boolean;
}

export function loadDeviceCa(privateKeyPem: string | undefined): DeviceCa {
  if (privateKeyPem && privateKeyPem.trim() !== '') {
    const privateKey = createPrivateKey(privateKeyPem.replace(/\\n/g, '\n'));
    if (privateKey.asymmetricKeyType !== 'ed25519')
      throw new Error('DEVICE_CA_PRIVATE_KEY_PEM must be an Ed25519 key');
    return { privateKey, publicKey: createPublicKey(privateKey), ephemeral: false };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey, ephemeral: true };
}

/** Compact certificate: `base64url(JSON payload).base64url(Ed25519 signature over the first part)`. */
export function issueCertificate(payload: DeviceCertificatePayload, ca: DeviceCa): string {
  const encoded = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = sign(null, Buffer.from(encoded, 'utf8'), ca.privateKey);
  return `${encoded}.${b64url(signature)}`;
}

export function verifyCertificate(
  certificate: string,
  caPublicKey: KeyObject,
): DeviceCertificatePayload | null {
  const [encoded, sig, ...rest] = certificate.split('.');
  if (!encoded || !sig || rest.length > 0) return null;
  const ok = verify(null, Buffer.from(encoded, 'utf8'), caPublicKey, Buffer.from(sig, 'base64url'));
  if (!ok) return null;
  try {
    return JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as DeviceCertificatePayload;
  } catch {
    return null;
  }
}
