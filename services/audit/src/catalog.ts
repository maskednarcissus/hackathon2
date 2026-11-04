/**
 * Recording lifecycle audit action catalog (docs/architecture/phase-1-capture-pipeline.md §9).
 * Actions in a governed namespace must be listed here; other namespaces are free-form.
 */
export const RECORDING_LIFECYCLE_ACTIONS = [
  'device.provisioning_token_created',
  'device.registered',
  'device.assigned',
  'device.unassigned',
  'device.certificate_revoked',
  'device.status_changed',
  'recording.scheduled',
  'recording.started',
  'recording.stopped',
  'recording.missed',
  'recording.metadata_received',
  'upload.started',
  'upload.completed',
  'upload.failed',
  'audio.quality_assessed',
  'audio.segmented',
  'transcription.started',
  'transcription.completed',
  'transcription.failed',
  'diarization.completed',
  'recording.class_identified',
  'alert.raised',
  'alert.acknowledged',
  'alert.resolved',
] as const;

export type RecordingLifecycleAction = (typeof RECORDING_LIFECYCLE_ACTIONS)[number];

export const GOVERNED_PREFIXES = [
  'device.',
  'recording.',
  'upload.',
  'audio.',
  'transcription.',
  'diarization.',
  'alert.',
] as const;

const catalog = new Set<string>(RECORDING_LIFECYCLE_ACTIONS);

export function isGovernedAction(action: string): boolean {
  return GOVERNED_PREFIXES.some((p) => action.startsWith(p));
}

export function isLifecycleAction(action: string): boolean {
  return catalog.has(action);
}

/** Returns an error message if the action is not acceptable, otherwise null. */
export function validateAction(action: string): string | null {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(action)) {
    return 'action must be dot-separated lowercase identifiers (e.g. "upload.completed")';
  }
  if (isGovernedAction(action) && !isLifecycleAction(action)) {
    return `action "${action}" is in a governed namespace but not in the recording lifecycle catalog`;
  }
  return null;
}
