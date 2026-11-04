/**
 * Hardware key attestation — format `ci-attest-v1` (Phase 6 §6.10, documented in
 * hardware/device-protocol/README.md §7).
 *
 * A device whose identity key lives in a secure element proves it with:
 *   chain:     [leaf attestation cert, …intermediates]   (leaf first; the last one is issued by a vendor root)
 *   statement: key attestation signed by the leaf key, binding the device's Ed25519 identity key
 *              (SPKI fingerprint) to its serial number, model and keystore.
 *
 * Every element is compact: `base64url(JSON payload) "." base64url(signature)`. Signatures are
 * Ed25519 (`keyAlg: "Ed25519"`) or ECDSA P-256/SHA-256 in IEEE-P1363 `r||s` form (`keyAlg: "ES256"`),
 * chosen by the *issuer's* key type.
 */
import {
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

export type KeyAlg = 'Ed25519' | 'ES256';

export interface AttestationCertPayload {
  v: 1;
  typ: 'ci-attest-cert';
  /** Subject name; the next element's `iss` must equal it. */
  sub: string;
  /** Issuer name: the subject of the next cert, or a configured root id. */
  iss: string;
  keyAlg: KeyAlg;
  /** base64url DER SubjectPublicKeyInfo of the subject key. */
  publicKey: string;
  /** Intermediates are CAs; the leaf is not. */
  ca: boolean;
  /** Validity window (ISO 8601). */
  nbf: string;
  exp: string;
  /** Leaf only: the device it was provisioned into at the factory. */
  serialNumber?: string;
  model?: string;
}

export interface KeyAttestationPayload {
  v: 1;
  typ: 'ci-key-attest';
  serialNumber: string;
  model: string;
  /** `sha256:<hex>` of the identity key's DER SPKI (same as the device certificate). */
  keyFingerprint: string;
  keystore: 'se050' | 'tpm';
  /** The key was generated inside the keystore and cannot be exported. */
  nonExportable: true;
  generatedAt: string;
}

export interface AttestationEvidence {
  chain: string[];
  statement: string;
}

export interface AttestationRoot {
  id: string;
  publicKey: KeyObject;
}

export interface VerifiedAttestation {
  format: 'ci-attest-v1';
  rootId: string;
  keystore: 'se050' | 'tpm';
  chainSubjects: string[];
  generatedAt: string;
  verifiedAt: string;
}

export class AttestationError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'AttestationError';
  }
}

const MAX_CHAIN = 4;

const b64url = (buf: Buffer): string => buf.toString('base64url');

export function keyAlgOf(key: KeyObject): KeyAlg {
  if (key.asymmetricKeyType === 'ed25519') return 'Ed25519';
  if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') {
    return 'ES256';
  }
  throw new AttestationError(
    'unsupported_key',
    `unsupported key type ${key.asymmetricKeyType ?? '?'}`,
  );
}

function signWith(key: KeyObject, data: Buffer): Buffer {
  return keyAlgOf(createPublicKey(key)) === 'Ed25519'
    ? cryptoSign(null, data, key)
    : cryptoSign('sha256', data, { key, dsaEncoding: 'ieee-p1363' });
}

function verifyWith(key: KeyObject, data: Buffer, signature: Buffer): boolean {
  try {
    return keyAlgOf(key) === 'Ed25519'
      ? cryptoVerify(null, data, key, signature)
      : cryptoVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    return false;
  }
}

/** Encodes and signs a compact element (used by factory tooling and tests). */
export function signCompact(payload: object, issuerPrivateKey: KeyObject): string {
  const encoded = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${encoded}.${b64url(signWith(issuerPrivateKey, Buffer.from(encoded, 'utf8')))}`;
}

function parseCompact<T>(token: string, what: string): { payload: T; signed: Buffer; sig: Buffer } {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AttestationError('malformed', `${what} is not a compact signed element`);
  }
  try {
    return {
      payload: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as T,
      signed: Buffer.from(parts[0], 'utf8'),
      sig: Buffer.from(parts[1], 'base64url'),
    };
  } catch {
    throw new AttestationError('malformed', `${what} payload is not JSON`);
  }
}

const asPublic = (key: KeyObject): KeyObject =>
  key.type === 'public' ? key : createPublicKey(key);

export const spkiOf = (key: KeyObject): string =>
  b64url(asPublic(key).export({ format: 'der', type: 'spki' }));

function publicKeyFromCert(cert: AttestationCertPayload): KeyObject {
  try {
    const key = createPublicKey({
      key: Buffer.from(cert.publicKey, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    if (keyAlgOf(key) !== cert.keyAlg) throw new Error('keyAlg does not match the key');
    return key;
  } catch (err) {
    throw new AttestationError('bad_key', `certificate ${cert.sub}: ${(err as Error).message}`);
  }
}

export function parseRoots(json: string | undefined): AttestationRoot[] {
  if (!json || json.trim() === '') return [];
  const raw = JSON.parse(json) as { id: string; publicKeyPem: string }[];
  return raw.map((r) => {
    const publicKey = createPublicKey(r.publicKeyPem.replace(/\\n/g, '\n'));
    keyAlgOf(publicKey);
    return { id: r.id, publicKey };
  });
}

/**
 * Verifies `evidence` for a registering device. Throws `AttestationError` with a machine-readable
 * reason (`malformed`, `untrusted_root`, `bad_signature`, `expired`, `not_ca`, `subject_mismatch`,
 * `key_mismatch`, `keystore_mismatch`, …).
 */
export function verifyAttestation(
  evidence: AttestationEvidence,
  expected: {
    serialNumber: string;
    model: string;
    keyFingerprint: string;
    keystore: 'se050' | 'tpm' | 'none';
  },
  roots: readonly AttestationRoot[],
  now: Date,
): VerifiedAttestation {
  if (evidence.chain.length === 0 || evidence.chain.length > MAX_CHAIN) {
    throw new AttestationError('malformed', `chain must have 1–${MAX_CHAIN} certificates`);
  }
  const certs = evidence.chain.map((c, i) =>
    parseCompact<AttestationCertPayload>(c, `chain[${i}]`),
  );
  const t = now.getTime();

  certs.forEach(({ payload }, i) => {
    if (payload.v !== 1 || payload.typ !== 'ci-attest-cert') {
      throw new AttestationError('malformed', `chain[${i}] is not a ci-attest-cert`);
    }
    if (!(Date.parse(payload.nbf) <= t && t < Date.parse(payload.exp))) {
      throw new AttestationError(
        'expired',
        `certificate ${payload.sub} is outside its validity window`,
      );
    }
    if (i > 0 && !payload.ca)
      throw new AttestationError('not_ca', `${payload.sub} may not issue certificates`);
  });

  // Each certificate is signed by the next one; the last by a configured vendor root.
  for (let i = 0; i < certs.length; i += 1) {
    const cert = certs[i]!;
    const issuer = certs[i + 1];
    if (issuer) {
      if (cert.payload.iss !== issuer.payload.sub) {
        throw new AttestationError(
          'subject_mismatch',
          `${cert.payload.sub} not issued by ${issuer.payload.sub}`,
        );
      }
      if (!verifyWith(publicKeyFromCert(issuer.payload), cert.signed, cert.sig)) {
        throw new AttestationError('bad_signature', `bad signature on ${cert.payload.sub}`);
      }
    }
  }
  const top = certs[certs.length - 1]!;
  const root = roots.find((r) => r.id === top.payload.iss);
  if (!root)
    throw new AttestationError(
      'untrusted_root',
      `issuer ${top.payload.iss} is not a trusted vendor root`,
    );
  if (!verifyWith(root.publicKey, top.signed, top.sig)) {
    throw new AttestationError('bad_signature', `bad root signature on ${top.payload.sub}`);
  }

  const leaf = certs[0]!.payload;
  if (leaf.ca) throw new AttestationError('malformed', 'leaf certificate must not be a CA');
  if (leaf.serialNumber !== expected.serialNumber || leaf.model !== expected.model) {
    throw new AttestationError(
      'subject_mismatch',
      'attestation certificate belongs to another device',
    );
  }

  const st = parseCompact<KeyAttestationPayload>(evidence.statement, 'statement');
  if (st.payload.v !== 1 || st.payload.typ !== 'ci-key-attest') {
    throw new AttestationError('malformed', 'statement is not a ci-key-attest');
  }
  if (!verifyWith(publicKeyFromCert(leaf), st.signed, st.sig)) {
    throw new AttestationError('bad_signature', 'bad signature on the key attestation');
  }
  const s = st.payload;
  if (s.serialNumber !== expected.serialNumber || s.model !== expected.model) {
    throw new AttestationError('subject_mismatch', 'statement belongs to another device');
  }
  if (s.keyFingerprint !== expected.keyFingerprint) {
    throw new AttestationError('key_mismatch', 'statement attests a different identity key');
  }
  if (s.nonExportable !== true) throw new AttestationError('exportable_key', 'key is exportable');
  if (expected.keystore !== 'none' && s.keystore !== expected.keystore) {
    throw new AttestationError(
      'keystore_mismatch',
      `model requires ${expected.keystore}, got ${s.keystore}`,
    );
  }
  return {
    format: 'ci-attest-v1',
    rootId: root.id,
    keystore: s.keystore,
    chainSubjects: certs.map((c) => c.payload.sub),
    generatedAt: s.generatedAt,
    verifiedAt: now.toISOString(),
  };
}
