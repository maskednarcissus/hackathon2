import type {
  CommandStatus,
  Device,
  DeviceAssignment,
  DeviceCommand,
  Heartbeat,
  ProvisioningToken,
} from './domain.js';

export interface DeviceRepository {
  saveDevice(device: Device): Promise<void>;
  getDevice(id: string): Promise<Device | undefined>;
  findDeviceBySerial(serialNumber: string): Promise<Device | undefined>;
  listDevices(filter?: { institutionId?: string; classroomId?: string }): Promise<Device[]>;

  saveToken(token: ProvisioningToken): Promise<void>;
  findTokenByHash(tokenHash: string): Promise<ProvisioningToken | undefined>;
  /**
   * Atomically consumes a provisioning token and creates/updates the device. Returns false (and
   * changes nothing) when the token was already used — prevents replay races.
   */
  registerDevice(tokenId: string, usedAt: string, device: Device): Promise<boolean>;

  saveAssignment(assignment: DeviceAssignment): Promise<void>;
  /**
   * Closes `close`, opens `open` and saves `device` as one unit. Throws `RepositoryConflictError`
   * when another device is already active in the classroom or the device already has an open
   * assignment.
   */
  applyAssignment(change: {
    device: Device;
    close?: DeviceAssignment;
    open?: DeviceAssignment;
  }): Promise<void>;
  getActiveAssignment(deviceId: string): Promise<DeviceAssignment | undefined>;
  listAssignments(deviceId: string): Promise<DeviceAssignment[]>;

  addHeartbeat(heartbeat: Heartbeat, retainPerDevice: number): Promise<void>;
  latestHeartbeat(deviceId: string): Promise<Heartbeat | undefined>;
  listHeartbeats(deviceId: string, limit: number): Promise<Heartbeat[]>;
  /** Heartbeats received at or after `since`, oldest first. */
  listHeartbeatsSince(deviceId: string, since: string): Promise<Heartbeat[]>;

  saveCommand(command: DeviceCommand): Promise<void>;
  /** Inserts unless an open (pending/delivered) command of the same type exists for the device. */
  createCommand(command: DeviceCommand): Promise<{ command: DeviceCommand; created: boolean }>;
  getCommand(id: string): Promise<DeviceCommand | undefined>;
  /** Newest first. */
  listCommands(
    filter: { deviceId?: string; statuses?: readonly CommandStatus[] },
    limit?: number,
  ): Promise<DeviceCommand[]>;
}

/** A uniqueness invariant (classroom occupancy, open assignment, open command) was violated. */
export class RepositoryConflictError extends Error {
  constructor(
    public readonly constraint: string,
    message: string,
  ) {
    super(message);
    this.name = 'RepositoryConflictError';
  }
}

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryDeviceRepository implements DeviceRepository {
  private readonly devices = new Map<string, Device>();
  private readonly tokens = new Map<string, ProvisioningToken>();
  private readonly assignments = new Map<string, DeviceAssignment>();
  private readonly heartbeats = new Map<string, Heartbeat[]>();
  private readonly commands = new Map<string, DeviceCommand>();

  saveDevice(device: Device): Promise<void> {
    this.devices.set(device.id, clone(device));
    return Promise.resolve();
  }
  getDevice(id: string): Promise<Device | undefined> {
    const d = this.devices.get(id);
    return Promise.resolve(d ? clone(d) : undefined);
  }
  findDeviceBySerial(serialNumber: string): Promise<Device | undefined> {
    const d = [...this.devices.values()].find((x) => x.serialNumber === serialNumber);
    return Promise.resolve(d ? clone(d) : undefined);
  }
  listDevices(filter: { institutionId?: string; classroomId?: string } = {}): Promise<Device[]> {
    return Promise.resolve(
      [...this.devices.values()]
        .filter(
          (d) =>
            (!filter.institutionId || d.institutionId === filter.institutionId) &&
            (!filter.classroomId || d.classroomId === filter.classroomId),
        )
        .sort((a, b) => a.serialNumber.localeCompare(b.serialNumber))
        .map(clone),
    );
  }

  saveToken(token: ProvisioningToken): Promise<void> {
    this.tokens.set(token.id, clone(token));
    return Promise.resolve();
  }
  findTokenByHash(tokenHash: string): Promise<ProvisioningToken | undefined> {
    const t = [...this.tokens.values()].find((x) => x.tokenHash === tokenHash);
    return Promise.resolve(t ? clone(t) : undefined);
  }
  registerDevice(tokenId: string, usedAt: string, device: Device): Promise<boolean> {
    const t = this.tokens.get(tokenId);
    if (!t || t.usedAt) return Promise.resolve(false);
    t.usedAt = usedAt;
    t.deviceId = device.id;
    this.devices.set(device.id, clone(device));
    return Promise.resolve(true);
  }

  applyAssignment(change: {
    device: Device;
    close?: DeviceAssignment;
    open?: DeviceAssignment;
  }): Promise<void> {
    const { device, close, open } = change;
    if (device.classroomId && device.credentialStatus === 'active') {
      const other = [...this.devices.values()].find(
        (d) =>
          d.id !== device.id &&
          d.classroomId === device.classroomId &&
          d.credentialStatus === 'active',
      );
      if (other)
        return Promise.reject(
          new RepositoryConflictError(
            'uq_capture_devices_active_classroom',
            'Classroom already has an active capture device',
          ),
        );
    }
    if (open) {
      const stillOpen = [...this.assignments.values()].find(
        (a) => a.deviceId === open.deviceId && !a.unassignedAt && a.id !== close?.id,
      );
      if (stillOpen)
        return Promise.reject(
          new RepositoryConflictError('uq_device_assignments_open', 'Device already assigned'),
        );
    }
    if (close) this.assignments.set(close.id, clone(close));
    if (open) this.assignments.set(open.id, clone(open));
    this.devices.set(device.id, clone(device));
    return Promise.resolve();
  }

  saveAssignment(assignment: DeviceAssignment): Promise<void> {
    this.assignments.set(assignment.id, clone(assignment));
    return Promise.resolve();
  }
  getActiveAssignment(deviceId: string): Promise<DeviceAssignment | undefined> {
    const a = [...this.assignments.values()].find(
      (x) => x.deviceId === deviceId && !x.unassignedAt,
    );
    return Promise.resolve(a ? clone(a) : undefined);
  }
  listAssignments(deviceId: string): Promise<DeviceAssignment[]> {
    return Promise.resolve(
      [...this.assignments.values()]
        .filter((x) => x.deviceId === deviceId)
        .sort((a, b) => b.assignedAt.localeCompare(a.assignedAt))
        .map(clone),
    );
  }

  addHeartbeat(heartbeat: Heartbeat, retainPerDevice: number): Promise<void> {
    const list = this.heartbeats.get(heartbeat.deviceId) ?? [];
    list.push(clone(heartbeat));
    if (list.length > retainPerDevice) list.splice(0, list.length - retainPerDevice);
    this.heartbeats.set(heartbeat.deviceId, list);
    return Promise.resolve();
  }
  latestHeartbeat(deviceId: string): Promise<Heartbeat | undefined> {
    const list = this.heartbeats.get(deviceId);
    const last = list?.[list.length - 1];
    return Promise.resolve(last ? clone(last) : undefined);
  }
  listHeartbeats(deviceId: string, limit: number): Promise<Heartbeat[]> {
    return Promise.resolve(
      (this.heartbeats.get(deviceId) ?? []).slice(-limit).reverse().map(clone),
    );
  }

  listHeartbeatsSince(deviceId: string, since: string): Promise<Heartbeat[]> {
    return Promise.resolve(
      (this.heartbeats.get(deviceId) ?? []).filter((h) => h.receivedAt >= since).map(clone),
    );
  }

  saveCommand(command: DeviceCommand): Promise<void> {
    this.commands.set(command.id, clone(command));
    return Promise.resolve();
  }
  createCommand(command: DeviceCommand): Promise<{ command: DeviceCommand; created: boolean }> {
    const existing = [...this.commands.values()].find(
      (c) =>
        c.deviceId === command.deviceId &&
        c.type === command.type &&
        (c.status === 'pending' || c.status === 'delivered'),
    );
    if (existing) return Promise.resolve({ command: clone(existing), created: false });
    this.commands.set(command.id, clone(command));
    return Promise.resolve({ command: clone(command), created: true });
  }
  getCommand(id: string): Promise<DeviceCommand | undefined> {
    const c = this.commands.get(id);
    return Promise.resolve(c ? clone(c) : undefined);
  }
  listCommands(
    filter: { deviceId?: string; statuses?: readonly CommandStatus[] },
    limit = Number.POSITIVE_INFINITY,
  ): Promise<DeviceCommand[]> {
    return Promise.resolve(
      [...this.commands.values()]
        .reverse()
        .filter(
          (c) =>
            (!filter.deviceId || c.deviceId === filter.deviceId) &&
            (!filter.statuses || filter.statuses.includes(c.status)),
        )
        .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
        .slice(0, limit)
        .map(clone),
    );
  }
}
