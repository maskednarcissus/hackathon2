import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp, type DeviceManagementApp } from '../app.js';
import {
  InMemoryAuditClient,
  InMemoryEventPublisher,
  type ClassroomInfo,
  type OrganizationClient,
  type RecordingPlan,
  type ScheduleClient,
} from '../clients.js';
import { loadDeviceCa } from '../crypto.js';
import { InMemoryDeviceRepository } from '../repository.js';
import { signDeviceRequest } from '../signature.js';

export const INSTITUTION_A = '11111111-1111-4111-8111-111111111111';
export const INSTITUTION_B = '22222222-2222-4222-8222-222222222222';
export const ROOM_A1 = 'aaaaaaaa-0000-4000-8000-000000000001';
export const ROOM_A2 = 'aaaaaaaa-0000-4000-8000-000000000002';
export const ROOM_B1 = 'bbbbbbbb-0000-4000-8000-000000000001';
export const CAMPUS_1 = 'dddddddd-0000-4000-8000-000000000001';
export const CAMPUS_2 = 'dddddddd-0000-4000-8000-000000000002';
export const ADMIN_TOKEN = 'test-admin-token';
export const ADMIN_ID = 'cccccccc-0000-4000-8000-000000000001';

export class FakeOrganizationClient implements OrganizationClient {
  readonly rooms = new Map<string, ClassroomInfo>([
    [
      ROOM_A1,
      {
        id: ROOM_A1,
        campusId: CAMPUS_1,
        institutionId: INSTITUTION_A,
        timezone: 'America/Sao_Paulo',
        name: 'Sala 101',
        code: 'A-101',
        campusName: 'Campus Paulista',
      },
    ],
    [
      ROOM_A2,
      {
        id: ROOM_A2,
        campusId: CAMPUS_1,
        institutionId: INSTITUTION_A,
        timezone: 'America/Sao_Paulo',
        name: 'Laboratório 2',
        code: 'LAB-2',
        campusName: 'Campus Paulista',
      },
    ],
    [
      ROOM_B1,
      {
        id: ROOM_B1,
        campusId: CAMPUS_2,
        institutionId: INSTITUTION_B,
        timezone: 'America/Recife',
        name: 'Auditório',
        code: 'AUD',
        campusName: 'Campus Recife',
      },
    ],
  ]);
  getClassroom(id: string): Promise<ClassroomInfo | null> {
    return Promise.resolve(this.rooms.get(id) ?? null);
  }
}

export class FakeScheduleClient implements ScheduleClient {
  readonly calls: { classroomId: string; from: string; to: string }[] = [];
  getRecordingPlan(classroomId: string, from: string, to: string): Promise<RecordingPlan> {
    this.calls.push({ classroomId, from, to });
    return Promise.resolve({
      classroomId,
      generatedAt: from,
      timezone: 'America/Sao_Paulo',
      windows: [],
    });
  }
}

export class MutableClock {
  constructor(public current = new Date('2026-11-04T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface Harness extends DeviceManagementApp {
  app: FastifyInstance;
  clock: MutableClock;
  audit: InMemoryAuditClient;
  events: InMemoryEventPublisher;
  repo: InMemoryDeviceRepository;
  schedule: FakeScheduleClient;
}

export function createHarness(options: { maxOpenCommandsPerDevice?: number } = {}): Harness {
  const clock = new MutableClock();
  const audit = new InMemoryAuditClient();
  const events = new InMemoryEventPublisher();
  const repo = new InMemoryDeviceRepository();
  const schedule = new FakeScheduleClient();
  const built = buildApp({
    ...options,
    adminToken: ADMIN_TOKEN,
    deps: {
      clock,
      audit,
      events,
      repo,
      schedule,
      organization: new FakeOrganizationClient(),
      ca: loadDeviceCa(undefined),
    },
  });
  return { ...built, clock, audit, events, repo, schedule };
}

export const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}`, 'x-actor-id': ADMIN_ID };

export interface TestDevice {
  deviceId: string;
  serialNumber: string;
  privateKey: KeyObject;
  certificate: string;
}

export async function createToken(
  h: Harness,
  serialNumber: string,
  institutionId = INSTITUTION_A,
  expiresInHours?: number,
): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/provisioning-tokens',
    headers: adminHeaders,
    payload: { serialNumber, institutionId, ...(expiresInHours ? { expiresInHours } : {}) },
  });
  if (res.statusCode !== 201) throw new Error(`token creation failed: ${res.body}`);
  return res.json<{ token: string }>().token;
}

export function newKeyPair(): { privateKey: KeyObject; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString() };
}

export async function registerDevice(
  h: Harness,
  serialNumber = 'CI-A1-000123',
  institutionId = INSTITUTION_A,
): Promise<TestDevice> {
  const token = await createToken(h, serialNumber, institutionId);
  const { privateKey, publicKeyPem } = newKeyPair();
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/devices/register',
    payload: {
      provisioningToken: token,
      serialNumber,
      model: 'ci-capture-a1',
      firmwareVersion: '1.0.0',
      publicKeyPem,
    },
  });
  if (res.statusCode !== 201) throw new Error(`registration failed: ${res.body}`);
  const body = res.json<{ deviceId: string; certificate: string }>();
  return { deviceId: body.deviceId, serialNumber, privateKey, certificate: body.certificate };
}

export async function assign(
  h: Harness,
  deviceId: string,
  classroomId: string,
): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method: 'PUT',
    url: `/v1/devices/${deviceId}/assignment`,
    headers: adminHeaders,
    payload: { classroomId },
  });
}

export const healthyMetrics = {
  firmwareVersion: '1.0.1',
  uptimeSeconds: 3600,
  cpuTempC: 52.5,
  diskFreeBytes: 20 * 1024 ** 3,
  diskTotalBytes: 32 * 1024 ** 3,
  bufferQueueCount: 0,
  bufferQueueBytes: 0,
  networkRssiDbm: -61,
  micLevelDbfs: -38,
  isRecording: false,
};

export async function signedInject(
  h: Harness,
  device: TestDevice,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  overrides: {
    timestamp?: string;
    privateKey?: KeyObject;
    deviceId?: string;
    tamperBody?: string;
  } = {},
): Promise<LightMyRequestResponse> {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const headers = signDeviceRequest({
    deviceId: overrides.deviceId ?? device.deviceId,
    privateKey: overrides.privateKey ?? device.privateKey,
    method,
    pathWithQuery: url,
    body,
    timestamp: overrides.timestamp ?? h.clock.now().toISOString(),
  });
  return h.app.inject({
    method,
    url,
    headers: {
      ...headers,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload: overrides.tamperBody ?? body }),
  });
}
