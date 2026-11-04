/**
 * Device model capability registry (Phase 6 §6.10). The registry is code (reviewed, versioned with
 * the firmware it describes); `GET /v1/device-models` exposes it.
 */

export type DeviceEncoding = 'wav' | 'flac' | 'opus';
export type HardwareKeystore = 'tpm' | 'se050' | 'none';

export interface DeviceCapabilities {
  micChannels: number;
  beamforming: boolean;
  onDeviceVad: boolean;
  onDeviceEncoding: DeviceEncoding[];
  hardwareKeystore: HardwareKeystore;
  lte: boolean;
}

/** What the device should capture and upload; sent with every recording plan. */
export interface CaptureProfile {
  /** Microphones captured (interleaved PCM s16le). */
  captureChannels: number;
  /** Channels in the uploaded file: 1 = beamformed (or single-mic) mono mixdown. */
  uploadChannels: 1;
  sampleRate: number;
  /** Upload encoding; the device falls back to `wav` when it cannot encode. */
  encoding: DeviceEncoding;
  beamforming: boolean;
  /** Keep the raw multichannel capture on the device (diagnostics; not uploaded). */
  keepRawMultichannel: boolean;
  vad: {
    enabled: boolean;
    /** Only silence inside the pre/post-roll is trimmed — never inside the class. */
    trimPreRoll: boolean;
    trimPostRoll: boolean;
    /** Speech threshold above the measured noise floor. */
    thresholdDb: number;
    /** Audio kept around the first/last speech frame. */
    marginMs: number;
  };
}

export interface DeviceModel {
  model: string;
  displayName: string;
  generation: number;
  capabilities: DeviceCapabilities;
  captureProfile: CaptureProfile;
  /** Registration must carry a hardware key attestation verified against a vendor root. */
  requiresAttestation: boolean;
}

export const DEVICE_MODELS: readonly DeviceModel[] = [
  {
    model: 'ci-capture-a1',
    displayName: 'Classroom Capture A1',
    generation: 1,
    capabilities: {
      micChannels: 1,
      beamforming: false,
      onDeviceVad: false,
      onDeviceEncoding: ['wav'],
      hardwareKeystore: 'none',
      lte: false,
    },
    captureProfile: {
      captureChannels: 1,
      uploadChannels: 1,
      sampleRate: 16_000,
      encoding: 'wav',
      beamforming: false,
      keepRawMultichannel: false,
      vad: {
        enabled: false,
        trimPreRoll: false,
        trimPostRoll: false,
        thresholdDb: 12,
        marginMs: 1000,
      },
    },
    requiresAttestation: false,
  },
  {
    model: 'ci-capture-a2',
    displayName: 'Classroom Capture A2 (4-mic array, LTE)',
    generation: 2,
    capabilities: {
      micChannels: 4,
      beamforming: true,
      onDeviceVad: true,
      onDeviceEncoding: ['wav', 'flac', 'opus'],
      hardwareKeystore: 'se050',
      lte: true,
    },
    captureProfile: {
      captureChannels: 4,
      uploadChannels: 1,
      sampleRate: 16_000,
      encoding: 'flac',
      beamforming: true,
      keepRawMultichannel: false,
      vad: {
        enabled: true,
        trimPreRoll: true,
        trimPostRoll: true,
        thresholdDb: 12,
        marginMs: 1000,
      },
    },
    requiresAttestation: true,
  },
];

const BY_NAME = new Map(DEVICE_MODELS.map((m) => [m.model, m]));

export const findDeviceModel = (model: string): DeviceModel | undefined => BY_NAME.get(model);
