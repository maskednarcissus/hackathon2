# Device Communication Protocol (v1)

Device ↔ cloud protocol for the Classroom Intelligence capture device. The normative
contract is [`docs/architecture/phase-1-capture-pipeline.md`](../../docs/architecture/phase-1-capture-pipeline.md)
(§3–§5); this page describes it from the device's point of view. Reference implementation:
[`hardware/firmware`](../firmware).

All traffic is HTTPS (TLS 1.2+). Bodies are JSON (UTF-8) except audio chunks
(`application/octet-stream`). Timestamps are ISO 8601 UTC with milliseconds
(`2026-11-04T22:00:00.000Z`).

## 1. Identity

| Item        | Value                                                                               |
| ----------- | ----------------------------------------------------------------------------------- |
| Key type    | Ed25519, generated on the device at first boot                                      |
| Private key | `/var/lib/ci-agent/identity/device.key`, PKCS#8 PEM, mode `0600`, never transmitted |
| Public key  | SubjectPublicKeyInfo PEM, sent once at registration                                 |
| Fingerprint | `sha256:<hex>` of the DER SubjectPublicKeyInfo                                      |
| Certificate | `<base64url(payload)>.<base64url(signature)>` issued by `ci-device-ca`, 365 days    |

### Registration (unsigned)

`POST {device-management}/v1/devices/register`

```json
{
  "provisioningToken": "pt_…",
  "serialNumber": "CI-A1-000123",
  "model": "ci-capture-a1",
  "firmwareVersion": "1.0.0",
  "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n…"
}
```

`201` → `{ deviceId, certificate, certificatePayload }`, stored in
`identity/registration.json` (0600). Provisioning tokens are single-use, bound to the
serial number and expire (default 72 h).

## 2. Request signing (every call after registration)

| Header               | Value                                                                |
| -------------------- | -------------------------------------------------------------------- |
| `X-Device-Id`        | device UUID                                                          |
| `X-Device-Timestamp` | request time (server accepts ±300 s)                                 |
| `X-Device-Signature` | base64 (standard alphabet) Ed25519 signature of the canonical string |

Canonical string — five lines joined by `\n`, no trailing newline:

```
CI-DEVICE-V1
<METHOD>                       e.g. POST
<path + query, as sent>        e.g. /v1/devices/7f…/recording-plan?from=…&to=…
<X-Device-Timestamp>
<hex sha256(raw body)>         empty body → e3b0c442…b855
```

The path is the raw, percent-encoded request target exactly as sent on the wire.

## 3. Heartbeat

`POST {device-management}/v1/devices/{deviceId}/heartbeat` every 60 s:

```json
{
  "sentAt": "2026-11-04T22:00:00.000Z",
  "firmwareVersion": "1.0.0",
  "uptimeSeconds": 86400,
  "diskFreeBytes": 21474836480,
  "diskTotalBytes": 32000000000,
  "cpuTempC": 52.3,
  "bufferQueueCount": 1,
  "bufferQueueBytes": 172800044,
  "spoolBytes": 172800044,
  "evictedRecordings": 0,
  "isRecording": true,
  "currentScheduledClassId": "…",
  "planFetchedAt": "2026-11-04T21:55:00.000Z",
  "clockSkewMs": 0
}
```

`cpuTempC`, `uptimeSeconds`, `currentScheduledClassId`, `planFetchedAt` and `lastError` are **omitted**
(never sent as `null`) when unknown. Unknown extra fields (`spoolBytes`, `planFetchedAt`) are ignored by the server.
The server treats a device with no heartbeat for 3 minutes as offline.

## 4. Recording plan

`GET {device-management}/v1/devices/{deviceId}/recording-plan?from=<iso>&to=<iso>`
(the device asks for `now − 1 h … now + 36 h` every 5 minutes). Response: contract §4.

Device rules:

- Record iff `recordStartAt ≤ now < recordStopAt` for some window with `recordingEnabled=true`.
- Overlapping windows → the window with the latest `recordStartAt` wins (file rotation at
  that instant; each file belongs to exactly one `scheduledClassId`).
- An active window with `recordingEnabled=false` forces idle.
- The last plan is cached on disk and used while offline. The server `Date` header is used
  to correct the local clock when skew exceeds 120 s (reported as `clockSkewMs`).

## 5. Recording events (best effort)

`POST {audio-ingestion}/v1/recording-events`

```json
{
  "type": "recording.started",
  "deviceId": "…",
  "localRecordingId": "…",
  "scheduledClassId": "…",
  "at": "…"
}
```

`type` ∈ `recording.started`, `recording.stopped`. Failures are logged, not retried — the
recording metadata (§6) carries authoritative times.

## 6. Upload

1. `POST /v1/recordings` — metadata (contract §5.1), idempotent by `localRecordingId`.
2. `POST /v1/uploads` — `{ recordingSessionId, totalSizeBytes, checksumSha256, chunkSizeBytes }`.
3. `PUT /v1/uploads/{uploadId}/chunks/{index}` — raw bytes, `X-Chunk-SHA256` (hex). Chunk _i_
   covers bytes `[i·chunkSize, (i+1)·chunkSize)` of the WAV file.
4. `GET /v1/uploads/{uploadId}` — `{ status, totalChunks, receivedChunks }`, used to resume.
5. `POST /v1/uploads/{uploadId}/complete` — server verifies the whole-file SHA-256.

| Response                 | Device behaviour                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 2xx                      | continue / mark `uploaded` after `complete`                                                                                    |
| 429, 5xx, network error  | exponential backoff with jitter (2 s, 4 s, 8 s … max 300 s), 5 attempts per cycle, then defer the recording and stop the cycle |
| 404/410 on upload status | upload expired: create a new upload                                                                                            |
| 422 on complete          | checksum mismatch: discard the upload id, start a new upload next cycle                                                        |
| other 4xx                | defer with backoff, keep the audio                                                                                             |

## 7. Offline behaviour

- Recording continues from the cached plan with no connectivity.
- Audio stays in the local spool (`/var/lib/ci-agent/spool`, index `index.json` written
  atomically) until upload completes; it survives reboots and power loss.
- Retention: uploaded audio is deleted after 24 h or earlier above the soft disk limit.
  Un-uploaded audio is deleted **only** above the hard limit (oldest first, never the live
  recording); each eviction is an incident logged on the device and reported via
  `evictedRecordings`.

---

# Protocol v1 additions for second-generation devices (Phase 6 §6.10)

## 8. Device models and capture profiles

`GET /v1/device-models` lists the registry (`ci-capture-a1`, `ci-capture-a2`) with capabilities
(`micChannels`, `beamforming`, `onDeviceVad`, `onDeviceEncoding`, `hardwareKeystore`, `lte`).
Registration with an unknown `model` is rejected (`422 unknown_model`).

The recording plan proxied by device-management (`GET /v1/devices/{id}/recording-plan`) carries:

```json
{ "deviceModel": "ci-capture-a2",
  "captureProfile": { "captureChannels": 4, "uploadChannels": 1, "sampleRate": 16000,
    "encoding": "flac", "beamforming": true, "keepRawMultichannel": false,
    "vad": { "enabled": true, "trimPreRoll": true, "trimPostRoll": true, "thresholdDb": 12, "marginMs": 1000 } },
  "windows": [ … ] }
```

The agent clamps the profile to what it detects (microphones, `flac` binary, keystore) and never
asks for more than the hardware can do — e.g. FLAC falls back to WAV. Uploads are always **mono**
(delay-and-sum beamformed mixdown); `audioFormat` is `wav_pcm_s16le` or `flac`. VAD only trims
silence inside the pre-roll (before `startsAt`) and post-roll (after `endsAt`); `startedAt`/`endedAt`
in the recording metadata describe the uploaded (trimmed) audio.

Heartbeats may include `capabilities` (what the firmware detected); device-management stores it per
device for the fleet console.

## 9. Hardware key attestation — `ci-attest-v1`

Units with a secure element (a2: NXP SE050) generate the Ed25519 identity key **inside** the element
at the factory. Registration then adds:

```json
"attestation": { "chain": ["<leaf cert>", "<intermediate cert>"], "statement": "<key attestation>" }
```

Every element is compact: `base64url(JSON payload) "." base64url(signature)`; the signature covers the
ASCII of the first part. Signature algorithm follows the **issuer** key: Ed25519, or ECDSA P-256 with
SHA-256 in raw IEEE-P1363 `r‖s` form (64 bytes).

Certificate payload (`typ: "ci-attest-cert"`):

| Field                   | Meaning                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `v`, `typ`              | `1`, `"ci-attest-cert"`                                                              |
| `sub` / `iss`           | subject / issuer names; `iss` = `sub` of the next chain element, or a vendor root id |
| `keyAlg`, `publicKey`   | `Ed25519` \| `ES256`; base64url DER SubjectPublicKeyInfo                             |
| `ca`                    | `true` for intermediates, `false` for the leaf                                       |
| `nbf`, `exp`            | validity window (ISO 8601)                                                           |
| `serialNumber`, `model` | leaf only: the unit the attestation key was provisioned into                         |

Statement payload (`typ: "ci-key-attest"`, signed by the leaf key):
`{ v: 1, serialNumber, model, keyFingerprint: "sha256:<hex of identity SPKI DER>", keystore: "se050"|"tpm", nonExportable: true, generatedAt }`.

Verification (device-management `src/attestation.ts`): 1–4 certificates, each within its validity
window; intermediates must be CAs; each certificate verifies under the next one's key and the last
under a configured vendor root (`DEVICE_ATTESTATION_ROOTS=[{"id","publicKeyPem"}]`); the leaf and the
statement must name the registering serial and model; `keyFingerprint` must equal the registered key;
`keystore` must match the model's `hardwareKeystore`. Failures → `422 attestation_invalid` with
`details.reason` (`untrusted_root`, `bad_signature`, `expired`, `not_ca`, `subject_mismatch`,
`key_mismatch`, `keystore_mismatch`, `malformed`). Models with `requiresAttestation` without evidence →
`422 attestation_required`. The verified result is stored on the device (`attestation`).

On the device the evidence lives in `identity/attestation.json` (written at the factory) and the
key is used through the keystore abstraction (`keystore = "pkcs11"`, see `hardware/firmware`).

## 10. Signed OTA updates

Manifest (`base64url(canonical JSON) "." base64url(Ed25519 signature)`, keys sorted, no whitespace):

```json
{
  "v": 1,
  "model": "ci-capture-a2",
  "version": "2.1.0",
  "url": "https://…/a2-2.1.0.img",
  "sha256": "<hex>",
  "sizeBytes": 104857600,
  "minVersion": "2.0.0",
  "releasedAt": "2026-11-01T00:00:00.000Z",
  "keyId": "release-2026"
}
```

Manifests are signed **offline** by the release pipeline; device-management only accepts manifests
that verify under `FIRMWARE_RELEASE_KEYS` (server-side signing exists for development only and is
refused in production). Rollout is per release (one model): `PUT /v1/firmware/releases/{id}/rollout
{ percent, halted? }`; a device is eligible when `sha256(releaseId:deviceId) mod 100 < percent`,
its version is older, `minVersion` is satisfied and the release is not halted.

| Method | Path                                      | Auth                                                                                 |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| GET    | `/v1/devices/{id}/firmware-update`        | device → `{ updateAvailable, releaseId, version, manifest, url, sha256, sizeBytes }` |
| POST   | `/v1/devices/{id}/firmware-update/status` | device: `{ releaseId, state: downloading\|staged\|installed\|failed, error? }`       |

The agent verifies the manifest with keys pinned in its config (`ota_public_keys`), checks model,
version and `minVersion`, streams the image with a hard size cap, verifies size + SHA-256 and only
then stages it with `ota/pending-update.json`. The platform installer (`ota_install_command`) runs
only when no class is being recorded; `installed` is reported after rebooting into the new version.
