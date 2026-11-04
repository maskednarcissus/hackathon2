import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { InMemoryAuditClient, InMemoryEventPublisher } from './clients.js';
import { signCompact, spkiOf, type AttestationRoot } from './attestation.js';
import { loadDeviceCa, publicKeyFingerprint } from './crypto.js';
import {
  canonicalJson,
  rolloutBucket,
  signManifest,
  verifyManifest,
  type FirmwareManifest,
} from './firmware.js';
import { InMemoryDeviceRepository } from './repository.js';
import {
  ADMIN_ID,
  INSTITUTION_A,
  ROOM_A1,
  FakeOrganizationClient,
  FakeScheduleClient,
  MutableClock,
  adminHeaders,
  healthyMetrics,
  signedInject,
  type Harness,
  type TestDevice,
} from './test/helpers.js';

const ed = (): { privateKey: KeyObject; publicKey: KeyObject } => generateKeyPairSync('ed25519');
const p256 = (): { privateKey: KeyObject; publicKey: KeyObject } =>
  generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

const vendorRoot = p256();
const ROOTS: AttestationRoot[] = [{ id: 'ci-vendor-root-2026', publicKey: vendorRoot.publicKey }];
const releaseKey = ed();
const TRUSTED = new Map([['release-2026', releaseKey.publicKey]]);

const NBF = '2026-01-01T00:00:00.000Z';
const EXP = '2031-01-01T00:00:00.000Z';

interface Evidence {
  chain: string[];
  statement: string;
}

/** Factory-style chain: vendor root (P-256) → intermediate (P-256) → SE050 attestation key (Ed25519). */
function attest(
  serialNumber: string,
  identityKey: KeyObject,
  overrides: {
    leafSerial?: string;
    rootKey?: KeyObject;
    rootId?: string;
    intermediateCa?: boolean;
    leafExp?: string;
    statementKey?: KeyObject;
    keyFingerprint?: string;
    keystore?: string;
  } = {},
): Evidence {
  const intermediate = p256();
  const leaf = ed();
  const intermediateCert = signCompact(
    {
      v: 1,
      typ: 'ci-attest-cert',
      sub: 'ci-factory-ca-1',
      iss: overrides.rootId ?? 'ci-vendor-root-2026',
      keyAlg: 'ES256',
      publicKey: spkiOf(intermediate.publicKey),
      ca: overrides.intermediateCa ?? true,
      nbf: NBF,
      exp: EXP,
    },
    overrides.rootKey ?? vendorRoot.privateKey,
  );
  const leafCert = signCompact(
    {
      v: 1,
      typ: 'ci-attest-cert',
      sub: `se050:${serialNumber}`,
      iss: 'ci-factory-ca-1',
      keyAlg: 'Ed25519',
      publicKey: spkiOf(leaf.publicKey),
      ca: false,
      nbf: NBF,
      exp: overrides.leafExp ?? EXP,
      serialNumber: overrides.leafSerial ?? serialNumber,
      model: 'ci-capture-a2',
    },
    intermediate.privateKey,
  );
  const statement = signCompact(
    {
      v: 1,
      typ: 'ci-key-attest',
      serialNumber,
      model: 'ci-capture-a2',
      keyFingerprint: overrides.keyFingerprint ?? publicKeyFingerprint(identityKey),
      keystore: overrides.keystore ?? 'se050',
      nonExportable: true,
      generatedAt: '2026-10-01T10:00:00.000Z',
    },
    overrides.statementKey ?? leaf.privateKey,
  );
  return { chain: [leafCert, intermediateCert], statement };
}

let h: Harness;

function harness(options: { releaseSigner?: boolean } = {}): Harness {
  const clock = new MutableClock();
  const audit = new InMemoryAuditClient();
  const events = new InMemoryEventPublisher();
  const repo = new InMemoryDeviceRepository();
  const schedule = new FakeScheduleClient();
  const built = buildApp({
    adminToken: 'test-admin-token',
    attestationRoots: ROOTS,
    firmwareTrustedKeys: TRUSTED,
    ...(options.releaseSigner
      ? { releaseSigner: { keyId: 'dev-signer', privateKey: ed().privateKey } }
      : {}),
    deps: {
      clock,
      audit,
      events,
      repo,
      schedule,
      organization: new FakeOrganizationClient(),
      ca: loadDeviceCa(undefined),
    },
  });
  return { ...built, clock, audit, events, repo, schedule };
}

beforeEach(() => {
  h = harness();
});

async function token(serialNumber: string): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/provisioning-tokens',
    headers: adminHeaders,
    payload: { serialNumber, institutionId: INSTITUTION_A },
  });
  return res.json<{ token: string }>().token;
}

async function registerA2(
  serialNumber: string,
  evidence?: (identity: KeyObject) => Evidence | undefined,
): Promise<{ res: LightMyRequestResponse; device: TestDevice | undefined }> {
  const identity = ed();
  const ev = evidence ? evidence(identity.publicKey) : attest(serialNumber, identity.publicKey);
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/devices/register',
    payload: {
      provisioningToken: await token(serialNumber),
      serialNumber,
      model: 'ci-capture-a2',
      firmwareVersion: '2.0.0',
      publicKeyPem: identity.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      ...(ev ? { attestation: ev } : {}),
    },
  });
  const device =
    res.statusCode === 201
      ? {
          deviceId: res.json<{ deviceId: string }>().deviceId,
          serialNumber,
          privateKey: identity.privateKey,
          certificate: res.json<{ certificate: string }>().certificate,
        }
      : undefined;
  return { res, device };
}

const errorOf = (res: LightMyRequestResponse): { code: string; details?: { reason?: string } } =>
  res.json<{ error: { code: string; details?: { reason?: string } } }>().error;

describe('device model registry', () => {
  it('lists a1/a2 with capabilities and capture profiles', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/device-models' });
    const items = res.json<{ items: { model: string }[] }>().items;
    expect(items.map((m) => m.model)).toEqual(['ci-capture-a1', 'ci-capture-a2']);
    const a2 = await h.app.inject({ method: 'GET', url: '/v1/device-models/ci-capture-a2' });
    expect(a2.json()).toMatchObject({
      capabilities: {
        micChannels: 4,
        beamforming: true,
        onDeviceVad: true,
        onDeviceEncoding: ['wav', 'flac', 'opus'],
        hardwareKeystore: 'se050',
        lte: true,
      },
      captureProfile: { captureChannels: 4, uploadChannels: 1, encoding: 'flac' },
      requiresAttestation: true,
    });
    expect((await h.app.inject({ method: 'GET', url: '/v1/device-models/x9' })).statusCode).toBe(
      404,
    );
  });

  it('rejects unknown models at registration', async () => {
    const identity = ed();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/devices/register',
      payload: {
        provisioningToken: await token('CI-X9-1'),
        serialNumber: 'CI-X9-1',
        model: 'ci-capture-x9',
        firmwareVersion: '1.0.0',
        publicKeyPem: identity.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      },
    });
    expect(errorOf(res).code).toBe('unknown_model');
  });
});

describe('a2 hardware key attestation', () => {
  it('registers with a valid chain and records the verified attestation', async () => {
    const { res, device } = await registerA2('CI-A2-000001');
    expect(res.statusCode).toBe(201);
    const stored = await h.repo.getDevice(device?.deviceId ?? '');
    expect(stored?.attestation).toMatchObject({
      format: 'ci-attest-v1',
      rootId: 'ci-vendor-root-2026',
      keystore: 'se050',
      chainSubjects: ['se050:CI-A2-000001', 'ci-factory-ca-1'],
    });
    expect(h.audit.events.find((e) => e.action === 'device.registered')).toBeDefined();
  });

  it('requires attestation for a2', async () => {
    const { res } = await registerA2('CI-A2-000002', () => undefined);
    expect(errorOf(res).code).toBe('attestation_required');
  });

  const cases: [string, (serial: string, key: KeyObject) => Evidence, string][] = [
    [
      'untrusted root',
      (s, k): Evidence => attest(s, k, { rootKey: p256().privateKey }),
      'bad_signature',
    ],
    [
      'unknown root id',
      (s, k): Evidence => attest(s, k, { rootId: 'evil-root' }),
      'untrusted_root',
    ],
    [
      'intermediate is not a CA',
      (s, k): Evidence => attest(s, k, { intermediateCa: false }),
      'not_ca',
    ],
    [
      'expired leaf',
      (s, k): Evidence => attest(s, k, { leafExp: '2026-06-01T00:00:00.000Z' }),
      'expired',
    ],
    [
      'leaf of another device',
      (s, k): Evidence => attest(s, k, { leafSerial: 'CI-A2-999999' }),
      'subject_mismatch',
    ],
    [
      'statement not signed by the leaf',
      (s, k): Evidence => attest(s, k, { statementKey: ed().privateKey }),
      'bad_signature',
    ],
    [
      'statement for another key',
      (s, k): Evidence => attest(s, k, { keyFingerprint: `sha256:${'0'.repeat(64)}` }),
      'key_mismatch',
    ],
    ['wrong keystore', (s, k): Evidence => attest(s, k, { keystore: 'tpm' }), 'keystore_mismatch'],
    [
      'tampered chain element',
      (s, k): Evidence => {
        const ev = attest(s, k);
        const [payload, sig] = (ev.chain[0] ?? '').split('.');
        const forged = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) as Record<
          string,
          unknown
        >;
        forged['exp'] = '2099-01-01T00:00:00.000Z';
        return {
          ...ev,
          chain: [
            `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig ?? ''}`,
            ev.chain[1] ?? '',
          ],
        };
      },
      'bad_signature',
    ],
  ];
  it.each(cases)('rejects %s', async (_name, build, reason) => {
    const serial = `CI-A2-${Math.random().toString().slice(2, 8)}`;
    const { res } = await registerA2(serial, (key) => build(serial, key));
    expect(res.statusCode).toBe(422);
    expect(errorOf(res)).toMatchObject({ code: 'attestation_invalid', details: { reason } });
  });
});

describe('capture profile & capabilities', () => {
  it('adds the model capture profile to the proxied plan and stores reported capabilities', async () => {
    const { device } = await registerA2('CI-A2-000010');
    const d = device as TestDevice;
    await h.app.inject({
      method: 'PUT',
      url: `/v1/devices/${d.deviceId}/assignment`,
      headers: adminHeaders,
      payload: { classroomId: ROOM_A1 },
    });
    const plan = await signedInject(h, d, 'GET', `/v1/devices/${d.deviceId}/recording-plan`);
    expect(plan.json()).toMatchObject({
      deviceModel: 'ci-capture-a2',
      captureProfile: {
        captureChannels: 4,
        sampleRate: 16000,
        encoding: 'flac',
        beamforming: true,
      },
      windows: [],
    });
    const capabilities = { micChannels: 4, flacEncoder: true, keystore: 'pkcs11' };
    await signedInject(h, d, 'POST', `/v1/devices/${d.deviceId}/heartbeat`, {
      ...healthyMetrics,
      firmwareVersion: '2.0.0',
      capabilities,
    });
    expect((await h.repo.getDevice(d.deviceId))?.reportedCapabilities).toEqual(capabilities);
    expect(
      (await h.repo.latestHeartbeat(d.deviceId)) as unknown as Record<string, unknown>,
    ).not.toHaveProperty('capabilities');
  });
});

describe('signed OTA manifests & staged rollout', () => {
  const manifest = (version: string, extra: Partial<FirmwareManifest> = {}): FirmwareManifest => ({
    v: 1,
    model: 'ci-capture-a2',
    version,
    url: `https://firmware.ci.example.com/a2/${version}.img`,
    sha256: 'a'.repeat(64),
    sizeBytes: 104_857_600,
    releasedAt: '2026-11-01T00:00:00.000Z',
    keyId: 'release-2026',
    ...extra,
  });
  const upload = (compact: string): Promise<LightMyRequestResponse> =>
    h.app.inject({
      method: 'POST',
      url: '/v1/firmware/releases',
      headers: adminHeaders,
      payload: { manifest: compact },
    });
  const rollout = (
    id: string,
    percent: number,
    halted?: boolean,
  ): Promise<LightMyRequestResponse> =>
    h.app.inject({
      method: 'PUT',
      url: `/v1/firmware/releases/${id}/rollout`,
      headers: adminHeaders,
      payload: { percent, ...(halted === undefined ? {} : { halted }) },
    });

  it('canonicalises JSON deterministically', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('accepts only manifests signed by a trusted release key', async () => {
    const ok = await upload(signManifest(manifest('2.1.0'), releaseKey.privateKey));
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ version: '2.1.0', rolloutPercent: 0, halted: false });
    const forged = await upload(signManifest(manifest('2.2.0'), ed().privateKey));
    expect(errorOf(forged)).toMatchObject({
      code: 'invalid_manifest',
      details: { reason: 'bad_signature' },
    });
    const unknownKey = await upload(
      signManifest(manifest('2.2.0', { keyId: 'nope' }), releaseKey.privateKey),
    );
    expect(errorOf(unknownKey).details?.reason).toBe('untrusted_key');
    expect((await upload(signManifest(manifest('2.1.0'), releaseKey.privateKey))).statusCode).toBe(
      409,
    );
    const unsigned = await h.app.inject({
      method: 'POST',
      url: '/v1/firmware/releases',
      headers: adminHeaders,
      payload: {
        model: 'ci-capture-a2',
        version: '2.3.0',
        url: 'https://x/y.img',
        sha256: 'b'.repeat(64),
        sizeBytes: 10,
      },
    });
    expect(errorOf(unsigned).code).toBe('signing_unavailable');
  });

  it('signs server-side only when a development signer is configured', async () => {
    h = harness({ releaseSigner: true });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/firmware/releases',
      headers: adminHeaders,
      payload: {
        model: 'ci-capture-a2',
        version: '2.3.0',
        url: 'https://x/y.img',
        sha256: 'b'.repeat(64),
        sizeBytes: 10,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      manifestPayload: { keyId: 'dev-signer', version: '2.3.0' },
    });
  });

  it('offers updates only to devices inside the rollout and reports progress', async () => {
    const devices: TestDevice[] = [];
    for (let i = 0; i < 12; i += 1) {
      const { device } = await registerA2(`CI-A2-1000${String(i).padStart(2, '0')}`);
      devices.push(device as TestDevice);
    }
    const created = await upload(
      signManifest(manifest('2.1.0', { minVersion: '2.0.0' }), releaseKey.privateKey),
    );
    const releaseId = created.json<{ releaseId: string }>().releaseId;
    const check = async (d: TestDevice): Promise<Record<string, unknown>> =>
      (await signedInject(h, d, 'GET', `/v1/devices/${d.deviceId}/firmware-update`)).json();

    expect(await check(devices[0] as TestDevice)).toEqual({
      updateAvailable: false,
      currentVersion: '2.0.0',
    });

    await rollout(releaseId, 50);
    const offered: TestDevice[] = [];
    for (const d of devices) {
      const res = await check(d);
      const expected = rolloutBucket(d.deviceId, releaseId) < 50;
      expect(res['updateAvailable']).toBe(expected);
      if (expected) {
        offered.push(d);
        // The device verifies the manifest itself with the pinned key.
        expect(verifyManifest(String(res['manifest']), TRUSTED).sha256).toBe('a'.repeat(64));
      }
    }

    const first = offered[0] ?? devices[0]!;
    if (offered.length === 0) await rollout(releaseId, 100);
    const status = await signedInject(
      h,
      first,
      'POST',
      `/v1/devices/${first.deviceId}/firmware-update/status`,
      {
        releaseId,
        state: 'staged',
      },
    );
    expect(status.statusCode).toBe(200);
    const progress = await h.app.inject({
      method: 'GET',
      url: `/v1/firmware/releases/${releaseId}`,
      headers: adminHeaders,
    });
    expect(progress.json()).toMatchObject({
      progress: { modelDevices: 12, reports: { staged: 1 } },
    });

    // Halting stops new offers; full rollout reaches everyone.
    await rollout(releaseId, 100, true);
    expect((await check(first))['updateAvailable']).toBe(false);
    await rollout(releaseId, 100, false);
    for (const d of devices) expect((await check(d))['updateAvailable']).toBe(true);

    // Once the device runs the version, nothing more is offered.
    await signedInject(h, first, 'POST', `/v1/devices/${first.deviceId}/heartbeat`, {
      ...healthyMetrics,
      firmwareVersion: '2.1.0',
    });
    expect((await check(first))['updateAvailable']).toBe(false);
    expect(h.audit.events.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'firmware.release_created',
        'firmware.rollout_changed',
        'firmware.update_reported',
      ]),
    );
  });

  it("respects minVersion and never offers another model's release", async () => {
    const { device } = await registerA2('CI-A2-200001');
    const d = device as TestDevice;
    const created = await upload(
      signManifest(manifest('3.0.0', { minVersion: '2.5.0' }), releaseKey.privateKey),
    );
    const id = created.json<{ releaseId: string }>().releaseId;
    await rollout(id, 100);
    expect(
      (await signedInject(h, d, 'GET', `/v1/devices/${d.deviceId}/firmware-update`)).json(),
    ).toMatchObject({
      updateAvailable: false,
    });
    const a1 = await upload(
      signManifest(manifest('9.0.0', { model: 'ci-capture-a1' }), releaseKey.privateKey),
    );
    const status = await signedInject(
      h,
      d,
      'POST',
      `/v1/devices/${d.deviceId}/firmware-update/status`,
      {
        releaseId: a1.json<{ releaseId: string }>().releaseId,
        state: 'failed',
      },
    );
    expect(status.statusCode).toBe(404);
    expect(ADMIN_ID).toBeTruthy();
  });
});
