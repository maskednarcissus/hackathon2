import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  issueCertificate,
  loadDeviceCa,
  parseEd25519PublicKey,
  publicKeyFingerprint,
  verifyCertificate,
} from './crypto.js';
import { canonicalString, signDeviceRequest, verifySignedRequest } from './signature.js';

const payload = {
  v: 1 as const,
  deviceId: 'd',
  serialNumber: 's',
  institutionId: 'i',
  publicKeyFingerprint: 'sha256:00',
  issuedAt: '2026-11-04T00:00:00.000Z',
  expiresAt: '2027-11-04T00:00:00.000Z',
  issuer: 'ci-device-ca' as const,
};

describe('device certificates', () => {
  it('round-trips and rejects tampering or a foreign CA', () => {
    const ca = loadDeviceCa(undefined);
    const cert = issueCertificate(payload, ca);
    expect(verifyCertificate(cert, ca.publicKey)).toEqual(payload);

    const [p, s] = cert.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, institutionId: 'evil' })).toString(
      'base64url',
    );
    expect(verifyCertificate(`${forged}.${s ?? ''}`, ca.publicKey)).toBeNull();
    expect(verifyCertificate(`${p ?? ''}.${s ?? ''}.x`, ca.publicKey)).toBeNull();
    expect(verifyCertificate(cert, loadDeviceCa(undefined).publicKey)).toBeNull();
  });

  it('loads a CA from PEM (with escaped newlines)', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString()
      .replace(/\n/g, '\\n');
    const ca = loadDeviceCa(pem);
    expect(ca.ephemeral).toBe(false);
    expect(verifyCertificate(issueCertificate(payload, ca), ca.publicKey)).not.toBeNull();
  });

  it('only accepts Ed25519 public keys and fingerprints them stably', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ format: 'pem', type: 'spki' })
      .toString();
    expect(() => parseEd25519PublicKey(rsa)).toThrow(/Ed25519/);
    const { publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    expect(publicKeyFingerprint(parseEd25519PublicKey(pem))).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(publicKeyFingerprint(parseEd25519PublicKey(pem))).toBe(publicKeyFingerprint(publicKey));
  });
});

describe('CI-DEVICE-V1 request signatures', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const now = new Date('2026-11-04T12:00:00.000Z');
  const base = {
    deviceId: 'dev',
    privateKey,
    method: 'post',
    pathWithQuery: '/v1/x?a=1',
    body: '{"a":1}',
    timestamp: now.toISOString(),
  };

  it('builds the canonical string exactly as specified', () => {
    expect(canonicalString('get', '/p?q=1', 'T', '')).toBe(
      'CI-DEVICE-V1\nGET\n/p?q=1\nT\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('accepts a valid signature and rejects tampering, skew and missing headers', () => {
    const h = signDeviceRequest(base);
    const input = {
      method: 'POST',
      pathWithQuery: '/v1/x?a=1',
      timestamp: h['X-Device-Timestamp'],
      signature: h['X-Device-Signature'],
      body: '{"a":1}',
    };
    expect(verifySignedRequest(input, publicKey, now)).toEqual({ ok: true });
    expect(verifySignedRequest({ ...input, body: '{"a":2}' }, publicKey, now)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
    expect(verifySignedRequest({ ...input, pathWithQuery: '/v1/x?a=2' }, publicKey, now)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
    expect(verifySignedRequest(input, publicKey, new Date(now.getTime() + 301_000))).toEqual({
      ok: false,
      reason: 'clock_skew',
    });
    expect(verifySignedRequest(input, publicKey, new Date(now.getTime() + 299_000))).toEqual({
      ok: true,
    });
    expect(verifySignedRequest({ ...input, signature: undefined }, publicKey, now)).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
    expect(verifySignedRequest({ ...input, timestamp: 'yesterday' }, publicKey, now)).toEqual({
      ok: false,
      reason: 'invalid_timestamp',
    });
    expect(verifySignedRequest({ ...input, signature: 'not-base64!!' }, publicKey, now)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });
});
