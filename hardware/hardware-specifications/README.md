# Hardware Specifications

Reference capture devices supported by the platform. The authoritative capability set is the model
registry in device-management (`services/device-management/src/models.ts`, `GET /v1/device-models`);
the firmware mirrors it in `ci_agent/capabilities.py`.

## Models

|                      | `ci-capture-a1` (gen 1)                                   | `ci-capture-a2` (gen 2)                                                    |
| -------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| Microphones          | 1 (omni MEMS)                                             | 4-mic linear array, 50 mm pitch (MEMS, matched ±1 dB)                      |
| Capture              | 16 kHz s16le mono                                         | 16 kHz s16le × 4, beamformed to mono on device                             |
| On-device processing | —                                                         | delay-and-sum beamforming, energy VAD (pre/post-roll trim)                 |
| Upload encoding      | WAV                                                       | FLAC (lossless, ~50 % of WAV), WAV fallback                                |
| Identity key         | file (`/var/lib/ci-agent/identity/device.key`, 0600)      | NXP SE050 secure element via PKCS#11, factory attestation (`ci-attest-v1`) |
| Uplink               | Ethernet / Wi-Fi                                          | Ethernet / Wi-Fi + LTE Cat-4 (`wwan0`)                                     |
| Local buffer         | ≥ 32 GB                                                   | ≥ 64 GB (raw 4-channel capture ≈ 1.8 GB / 2 h)                             |
| OTA                  | signed manifests (Ed25519), A/B rootfs recommended (RAUC) | same                                                                       |

## Acoustic requirements

- Self-noise ≤ 32 dBA per microphone; SNR ≥ 65 dB(A); flat response 100 Hz–8 kHz (±3 dB).
- Speech at 6 m from the array (typical lectern distance) must yield ≥ 15 dB SNR after beamforming
  in a room with 40 dBA background (the platform's `low_snr` threshold, Phase 1 §7).
- Clipping must not occur below 110 dB SPL.

## Array geometry & beamforming

Configure microphone positions in metres in the agent config (`mic_positions = "0,0;0.05,0;0.10,0;0.15,0"`)
and the steering azimuth (`beam_azimuth_deg`, 0° = broadside towards the lectern). Integer-sample
delays are derived from the geometry (343 m/s); for uncorrelated noise the 4-mic array gives ≈ +6 dB SNR.

## Installation

- Mount the array at 2.2–2.8 m, centred on the teaching wall, broadside towards the lectern.
- Keep ≥ 1 m from HVAC outlets and projectors; avoid corners (reverberation build-up).
- PoE (802.3af) or 12 V DC; the unit must finalize recordings on SIGTERM within 30 s.
