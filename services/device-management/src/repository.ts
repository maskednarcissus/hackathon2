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
  /** Atomically marks a token as used; returns false if it was already used (prevents replay races). */
  consumeToken(tokenId: string, usedAt: string, deviceId: string): Promise<boolean>;

  saveAssignment(assignment: DeviceAssignment): Promise<void>;
  getActiveAssignment(deviceId: string): Promise<DeviceAssignment | undefined>;
  listAssignments(deviceId: string): Promise<DeviceAssignment[]>;

  addHeartbeat(heartbeat: Heartbeat, retainPerDevice: number): Promise<void>;
  latestHeartbeat(deviceId: string): Promise<Heartbeat | undefined>;
  listHeartbeats(deviceId: string, limit: number): Promise<Heartbeat[]>;
  /** Heartbeats received at or after `since`, oldest first. */
  listHeartbeatsSince(deviceId: string, since: string): Promise<Heartbeat[]>;

  saveCommand(command: DeviceCommand): Promise<void>;
  getCommand(id: string): Promise<DeviceCommand | undefined>;
  /** Newest first. */
  listCommands(
    filter: { deviceId?: string; statuses?: readonly CommandStatus[] },
    limit?: number,
  ): Promise<DeviceCommand[]>;
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
  consumeToken(tokenId: string, usedAt: string, deviceId: string): Promise<boolean> {
    const t = this.tokens.get(tokenId);
    if (!t || t.usedAt) return Promise.resolve(false);
    t.usedAt = usedAt;
    t.deviceId = deviceId;
    return Promise.resolve(true);
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
