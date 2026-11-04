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
