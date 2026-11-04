/**
 * Audit action catalog: phase-1 contract §9 (recording lifecycle), phase-2 §8, phase-3 §2/§7.
 * Actions in a governed namespace must be listed here; open namespaces accept any well-formed
 * action; all other namespaces are free-form.
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
  'alert.escalated',
  'alert.assigned',
  'alert.in_progress',
  'alert.commented',
  // Phase 2 — classroom intelligence (phase-2 contract §8)
  'ai.generation',
  'lecture.structured',
  'event.extracted',
  'event.confirmed',
  'event.edited',
  'event.rejected',
  'event.published',
  'event.deduplicated',
  'transcript.corrected',
  'calendar.event_published',
  'calendar.event_updated',
  // Phase 3 — student experience (phase-3 contract §2, §7)
  'content.reported',
  'content.report_resolved',
  'auth.login_succeeded',
  'auth.login_failed',
  'auth.locked',
  'auth.refresh_reuse_detected',
  'auth.logout',
  'auth.user_created',
  // Emitted by services beyond the original contract lists
  'calendar.feed_token_rotated',
  'device.heartbeat_missed',
  'diarization.failed',
  'event.updated',
  'recording.segmented',
  'recording.uploaded',
  'transcript.created',
] as const;

/**
 * Namespaces open to any action name (`lecture.viewed`, `calendar.feed_rotated`, …). Their
 * well-known actions are still listed above for documentation.
 */
export const OPEN_NAMESPACES = ['lecture.', 'event.', 'calendar.'] as const;

export type RecordingLifecycleAction = (typeof RECORDING_LIFECYCLE_ACTIONS)[number];

export const GOVERNED_PREFIXES = [
  'device.',
  'recording.',
  'upload.',
  'audio.',
  'transcription.',
  'diarization.',
  'alert.',
  'transcript.',
  'content.',
  'auth.',
  'ai.',
] as const;

const catalog = new Set<string>(RECORDING_LIFECYCLE_ACTIONS);

/** Governed namespaces accept only catalogued action names. */
export function isGovernedAction(action: string): boolean {
  return GOVERNED_PREFIXES.some((p) => action.startsWith(p));
}

export function isOpenNamespaceAction(action: string): boolean {
  return OPEN_NAMESPACES.some((p) => action.startsWith(p));
}

/** Namespaces whose events belong to a recording's lifecycle timeline. */
export const LIFECYCLE_PREFIXES = [
  'device.',
  'recording.',
  'upload.',
  'audio.',
  'transcription.',
  'diarization.',
  'alert.',
  'transcript.',
] as const;

export function isLifecycleTimelineAction(action: string): boolean {
  return LIFECYCLE_PREFIXES.some((p) => action.startsWith(p));
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
    return `action "${action}" is in a governed namespace but not in the audit action catalog`;
  }
  return null;
}
