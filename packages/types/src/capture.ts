export interface Classroom {
  id: string;
  campusId: string;
  name: string;
  capacity?: number;
}

export interface CaptureDevice {
  id: string;
  classroomId: string;
  serialNumber: string;
  model: string;
  firmwareVersion: string;
  status: DeviceStatus;
  lastSeenAt?: Date;
}

export type DeviceStatus =
  | 'online'
  | 'offline'
  | 'recording'
  | 'uploading'
  | 'attention_required'
  | 'maintenance'
  | 'decommissioned';

export interface RecordingSession {
  id: string;
  deviceId: string;
  classroomId: string;
  scheduledClassId?: string;
  startedAt: Date;
  endedAt?: Date;
  durationSeconds?: number;
  audioFormat: string;
  sampleRate: number;
  channels: number;
  fileSizeBytes?: number;
  checksumSha256?: string;
  uploadStatus: UploadStatus;
  captureStatus: CaptureStatus;
}

export type UploadStatus = 'pending' | 'uploading' | 'complete' | 'failed';
export type CaptureStatus = 'in_progress' | 'complete' | 'failed' | 'partial';

export interface TranscriptSegment {
  id: string;
  transcriptId: string;
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel?: string;
  confidence: number;
  language: string;
  correctionStatus: 'original' | 'corrected';
}
