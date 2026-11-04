/**
 * Signed OTA manifests and staged rollout (Phase 6 §6.10; device-protocol README §8).
 *
 * Manifest = `base64url(canonical JSON) "." base64url(Ed25519 signature over the first part)`.
 * Canonical JSON: object keys sorted recursively, no whitespace. Devices pin the release public
 * keys (`keyId` → key) in firmware; the server only stores and serves what release keys signed.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { compareVersions } from './fleet.js';

export interface FirmwareManifest {
  v: 1;
  model: string;
  version: string;
  /** HTTPS location of the image (e.g. a signed GCS URL or CDN path). */
  url: string;
  sha256: string;
  sizeBytes: number;
  /** Devices below this version must go through an intermediate release first. */
  minVersion?: string;
  releasedAt: string;
  keyId: string;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function signManifest(manifest: FirmwareManifest, privateKey: KeyObject): string {
  const encoded = Buffer.from(canonicalJson(manifest), 'utf8').toString('base64url');
  return `${encoded}.${sign(null, Buffer.from(encoded, 'utf8'), privateKey).toString('base64url')}`;
}

export class ManifestError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'ManifestError';
  }
}

export function verifyManifest(
  compact: string,
  trustedKeys: ReadonlyMap<string, KeyObject>,
): FirmwareManifest {
  const [encoded, sig, ...rest] = compact.split('.');
  if (!encoded || !sig || rest.length > 0)
    throw new ManifestError('malformed', 'not a compact manifest');
  let manifest: FirmwareManifest;
  try {
    manifest = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as FirmwareManifest;
  } catch {
    throw new ManifestError('malformed', 'manifest payload is not JSON');
  }
  const key = trustedKeys.get(manifest.keyId);
  if (!key)
    throw new ManifestError('untrusted_key', `manifest key ${manifest.keyId} is not trusted`);
  let ok = false;
  try {
    ok = verify(null, Buffer.from(encoded, 'utf8'), key, Buffer.from(sig, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) throw new ManifestError('bad_signature', 'manifest signature is invalid');
  if (
    manifest.v !== 1 ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
    !Number.isInteger(manifest.sizeBytes) ||
    manifest.sizeBytes <= 0 ||
    !/^https?:\/\//.test(manifest.url)
  ) {
    throw new ManifestError('malformed', 'manifest fields are invalid');
  }
  return manifest;
}

export function parseTrustedKeys(json: string | undefined): Map<string, KeyObject> {
  const map = new Map<string, KeyObject>();
  if (!json || json.trim() === '') return map;
  for (const k of JSON.parse(json) as { keyId: string; publicKeyPem: string }[]) {
    const key = createPublicKey(k.publicKeyPem.replace(/\\n/g, '\n'));
    if (key.asymmetricKeyType !== 'ed25519')
      throw new Error(`release key ${k.keyId} must be Ed25519`);
    map.set(k.keyId, key);
  }
  return map;
}

export interface ReleaseSigner {
  keyId: string;
  privateKey: KeyObject;
}

export function loadReleaseSigner(
  pem: string | undefined,
  keyId: string | undefined,
): ReleaseSigner | undefined {
  if (!pem || !keyId) return undefined;
  const privateKey = createPrivateKey(pem.replace(/\\n/g, '\n'));
  if (privateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('release signing key must be Ed25519');
  return { keyId, privateKey };
}

/** Stable 0–99 bucket of a device for a release: rollout `p%` reaches buckets `< p`. */
export function rolloutBucket(deviceId: string, releaseId: string): number {
  const digest = createHash('sha256').update(`${releaseId}:${deviceId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

export interface FirmwareRelease {
  id: string;
  model: string;
  version: string;
  manifest: string;
  manifestPayload: FirmwareManifest;
  rolloutPercent: number;
  halted: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FirmwareUpdateState = 'downloading' | 'staged' | 'installed' | 'failed';

export interface FirmwareUpdateReport {
  id: string;
  deviceId: string;
  releaseId: string;
  state: FirmwareUpdateState;
  error?: string;
  reportedAt: string;
}

/** Newest eligible release for a device, or undefined. */
export function selectRelease(
  releases: readonly FirmwareRelease[],
  device: { id: string; model: string; firmwareVersion: string },
): FirmwareRelease | undefined {
  return releases
    .filter(
      (r) =>
        r.model === device.model &&
        !r.halted &&
        r.rolloutPercent > 0 &&
        compareVersions(r.version, device.firmwareVersion) > 0 &&
        (!r.manifestPayload.minVersion ||
          compareVersions(device.firmwareVersion, r.manifestPayload.minVersion) >= 0) &&
        rolloutBucket(device.id, r.id) < r.rolloutPercent,
    )
    .sort((a, b) => compareVersions(b.version, a.version))[0];
}
