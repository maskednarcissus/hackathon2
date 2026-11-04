import {
  DeviceDirectoryUnavailableError,
  OrganizationUnavailableError,
  type DeviceDirectory,
  type DeviceInfo,
  type OrganizationClient,
  type RecordingPolicySummary,
} from './clients.js';
import type { AcademicRepository } from './repository.js';

export interface AlertContextQuery {
  institutionId?: string;
  at: Date;
  lookbackMinutes: number;
  lookaheadMinutes: number;
}

/** Body compatible with notifications `POST /v1/alerts/evaluate` (`now`, `classWindows`, `devices`). */
export interface AlertContext {
  now: string;
  classWindows: {
    scheduledClassId: string;
    classroomId: string;
    deviceId: string | null;
    institutionId: string;
    recordStartAt: string;
    recordStopAt: string;
    recordingEnabled: boolean;
  }[];
  devices: {
    deviceId: string;
    classroomId: string | null;
    institutionId: string;
    lastSeenAt: string | null;
    status: string;
  }[];
  /** Upstreams that could not be read (the feed degrades instead of failing). */
  errors: Record<string, string>;
}

const MAX_ROLL_MINUTES = 60;

/**
 * Class windows around `at` (recording window = class ± the classroom policy's pre/post roll) with the
 * device assigned to each classroom, plus the active device list, for the alert rules
 * (device_offline, recording_missed, low_storage).
 */
export async function buildAlertContext(
  q: AlertContextQuery,
  repo: AcademicRepository,
  organization: OrganizationClient,
  devices: DeviceDirectory | undefined,
): Promise<AlertContext> {
  const errors: Record<string, string> = {};
  const from = new Date(q.at.getTime() - (q.lookbackMinutes + MAX_ROLL_MINUTES) * 60_000);
  const to = new Date(q.at.getTime() + (q.lookaheadMinutes + MAX_ROLL_MINUTES) * 60_000);
  const classes = await repo.findScheduledClasses({
    ...(q.institutionId !== undefined ? { institutionId: q.institutionId } : {}),
    from: from.toISOString(),
    to: to.toISOString(),
  });

  let deviceList: DeviceInfo[] = [];
  if (devices) {
    try {
      deviceList = (await devices.listDevices(q.institutionId)).filter(
        (d) => d.credentialStatus === 'active',
      );
    } catch (err) {
      if (!(err instanceof DeviceDirectoryUnavailableError)) throw err;
      errors['devices'] = err.message;
    }
  }
  const deviceByClassroom = new Map(
    deviceList.filter((d) => d.classroomId).map((d) => [d.classroomId ?? '', d.id]),
  );

  const policies = new Map<string, RecordingPolicySummary | null>();
  for (const classroomId of new Set(classes.map((c) => c.classroomId))) {
    try {
      policies.set(classroomId, await organization.getClassroomRecordingPolicy(classroomId));
    } catch (err) {
      if (!(err instanceof OrganizationUnavailableError)) throw err;
      errors['organization'] = err.message;
    }
  }

  const windowStart = q.at.getTime() - q.lookbackMinutes * 60_000;
  const windowEnd = q.at.getTime() + q.lookaheadMinutes * 60_000;
  const classWindows: AlertContext['classWindows'] = [];
  for (const c of classes) {
    const policy = policies.get(c.classroomId);
    const start = Date.parse(c.startsAt) - (policy?.preRollMinutes ?? 0) * 60_000;
    const stop = Date.parse(c.endsAt) + (policy?.postRollMinutes ?? 0) * 60_000;
    if (stop < windowStart || start > windowEnd) continue;
    classWindows.push({
      scheduledClassId: c.id,
      classroomId: c.classroomId,
      deviceId: deviceByClassroom.get(c.classroomId) ?? null,
      institutionId: c.institutionId,
      recordStartAt: new Date(start).toISOString(),
      recordStopAt: new Date(stop).toISOString(),
      // Unknown policy (organization down) → assume enabled so missed recordings are still flagged.
      recordingEnabled: policy === undefined ? true : policy?.recordingEnabled === true,
    });
  }
  return {
    now: q.at.toISOString(),
    classWindows,
    devices: deviceList.map((d) => ({
      deviceId: d.id,
      classroomId: d.classroomId,
      institutionId: d.institutionId,
      lastSeenAt: d.lastSeenAt,
      status: d.status,
    })),
    errors,
  };
}
