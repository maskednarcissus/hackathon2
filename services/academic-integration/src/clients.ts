export interface RecordingPolicySummary {
  id: string;
  preRollMinutes: number;
  postRollMinutes: number;
  recordingEnabled: boolean;
}

export interface OrganizationClient {
  /** Effective recording policy of a classroom, or null when none is configured. */
  getClassroomRecordingPolicy(classroomId: string): Promise<RecordingPolicySummary | null>;
}

export class OrganizationUnavailableError extends Error {}

export class HttpOrganizationClient implements OrganizationClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 3000,
  ) {}

  async getClassroomRecordingPolicy(classroomId: string): Promise<RecordingPolicySummary | null> {
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/v1/classrooms/${encodeURIComponent(classroomId)}/recording-policy`,
        {
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (err) {
      throw new OrganizationUnavailableError(`organization service unreachable: ${String(err)}`);
    }
    if (res.status === 404) return null;
    if (!res.ok)
      throw new OrganizationUnavailableError(`organization service returned ${res.status}`);
    const body = (await res.json()) as Partial<RecordingPolicySummary>;
    if (typeof body.id !== 'string')
      throw new OrganizationUnavailableError('invalid recording policy response');
    return {
      id: body.id,
      preRollMinutes: Number(body.preRollMinutes ?? 0),
      postRollMinutes: Number(body.postRollMinutes ?? 0),
      recordingEnabled: body.recordingEnabled !== false,
    };
  }
}

export interface AuditEventInput {
  tenantId?: string;
  actorId?: string;
  actorType: 'student' | 'professor' | 'coordinator' | 'admin' | 'system' | 'device';
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
}

/** Audit emission is best-effort: failures are logged, never propagated to the caller. */
export interface AuditClient {
  record(event: AuditEventInput): Promise<void>;
}

export class HttpAuditClient implements AuditClient {
  constructor(
    private readonly baseUrl: string,
    private readonly onError: (err: unknown) => void = () => undefined,
    private readonly timeoutMs = 2000,
  ) {}

  async record(event: AuditEventInput): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/audit-events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) this.onError(new Error(`audit service returned ${res.status}`));
    } catch (err) {
      this.onError(err);
    }
  }
}

export class InMemoryAuditClient implements AuditClient {
  readonly events: AuditEventInput[] = [];
  record(event: AuditEventInput): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

export class StaticOrganizationClient implements OrganizationClient {
  constructor(private readonly policies: Map<string, RecordingPolicySummary | null> = new Map()) {}
  set(classroomId: string, policy: RecordingPolicySummary | null): void {
    this.policies.set(classroomId, policy);
  }
  getClassroomRecordingPolicy(classroomId: string): Promise<RecordingPolicySummary | null> {
    return Promise.resolve(this.policies.get(classroomId) ?? null);
  }
}

// ---------------------------------------------------------------- organization classrooms (sync §3)

export interface ClassroomInfo {
  classroomId: string;
  institutionId: string;
  campusId: string;
  campusName: string | null;
  name: string | null;
}

export interface ClassroomDirectory {
  /** organization `GET /v1/classrooms?institutionId=` */
  listClassrooms(institutionId: string): Promise<ClassroomInfo[]>;
}

export class HttpClassroomDirectory implements ClassroomDirectory {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 5000,
  ) {}

  async listClassrooms(institutionId: string): Promise<ClassroomInfo[]> {
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/v1/classrooms?institutionId=${encodeURIComponent(institutionId)}`,
        {
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (err) {
      throw new OrganizationUnavailableError(`organization service unreachable: ${String(err)}`);
    }
    if (!res.ok)
      throw new OrganizationUnavailableError(`organization service returned ${res.status}`);
    const body = (await res.json()) as {
      items?: {
        id: string;
        institutionId: string;
        campusId: string;
        campusName?: string;
        name?: string;
      }[];
    };
    return (body.items ?? []).map((c) => ({
      classroomId: c.id,
      institutionId: c.institutionId,
      campusId: c.campusId,
      campusName: c.campusName ?? null,
      name: c.name ?? null,
    }));
  }
}

export class StaticClassroomDirectory implements ClassroomDirectory {
  constructor(public classrooms: ClassroomInfo[] = []) {}
  listClassrooms(institutionId: string): Promise<ClassroomInfo[]> {
    return Promise.resolve(this.classrooms.filter((c) => c.institutionId === institutionId));
  }
}

// ---------------------------------------------------------------- device-management (alert context)

export interface DeviceInfo {
  id: string;
  institutionId: string;
  classroomId: string | null;
  lastSeenAt: string | null;
  status: string;
  credentialStatus: string;
}

export class DeviceDirectoryUnavailableError extends Error {}

export interface DeviceDirectory {
  /** device-management `GET /v1/devices[?institutionId=]` (admin bearer token). */
  listDevices(institutionId?: string): Promise<DeviceInfo[]>;
}

export class HttpDeviceDirectory implements DeviceDirectory {
  constructor(
    private readonly baseUrl: string,
    private readonly adminToken: string | undefined,
    private readonly timeoutMs = 5000,
  ) {}

  async listDevices(institutionId?: string): Promise<DeviceInfo[]> {
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/v1/devices${institutionId ? `?institutionId=${encodeURIComponent(institutionId)}` : ''}`,
        {
          headers: this.adminToken ? { authorization: `Bearer ${this.adminToken}` } : {},
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (err) {
      throw new DeviceDirectoryUnavailableError(`device-management unreachable: ${String(err)}`);
    }
    if (!res.ok)
      throw new DeviceDirectoryUnavailableError(`device-management returned ${res.status}`);
    const body = (await res.json()) as {
      items?: {
        id: string;
        institutionId: string;
        classroomId?: string | null;
        lastSeenAt?: string | null;
        status: string;
        credentialStatus: string;
      }[];
    };
    return (body.items ?? []).map((d) => ({
      id: d.id,
      institutionId: d.institutionId,
      classroomId: d.classroomId ?? null,
      lastSeenAt: d.lastSeenAt ?? null,
      status: d.status,
      credentialStatus: d.credentialStatus,
    }));
  }
}

export class StaticDeviceDirectory implements DeviceDirectory {
  constructor(public devices: DeviceInfo[] = []) {}
  listDevices(institutionId?: string): Promise<DeviceInfo[]> {
    return Promise.resolve(
      this.devices.filter((d) => institutionId === undefined || d.institutionId === institutionId),
    );
  }
}
