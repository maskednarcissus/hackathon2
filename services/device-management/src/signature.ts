/**
 * Device request signing (contract §3, CI-DEVICE-V1).
 *
 * Reusable by any TypeScript service: `verifySignedRequest` is framework-agnostic and
 * `createDeviceAuthHook` wraps it as a Fastify preHandler.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { sha256Hex } from './crypto.js';
import { forbidden, unauthorized } from './errors.js';

export const SIGNATURE_SCHEME = 'CI-DEVICE-V1';
export const MAX_CLOCK_SKEW_SECONDS = 300;

export const HEADER_DEVICE_ID = 'x-device-id';
export const HEADER_TIMESTAMP = 'x-device-timestamp';
export const HEADER_SIGNATURE = 'x-device-signature';

export function canonicalString(
  method: string,
  pathWithQuery: string,
  timestamp: string,
  body: Buffer | string,
): string {
  return [SIGNATURE_SCHEME, method.toUpperCase(), pathWithQuery, timestamp, sha256Hex(body)].join(
    '\n',
  );
}

export interface SignedRequestInput {
  method: string;
  pathWithQuery: string;
  timestamp: string | undefined;
  signature: string | undefined;
  body: Buffer | string;
}

export type VerificationFailure =
  'missing_headers' | 'invalid_timestamp' | 'clock_skew' | 'invalid_signature';

export type VerificationResult = { ok: true } | { ok: false; reason: VerificationFailure };

export function verifySignedRequest(
  input: SignedRequestInput,
  publicKey: KeyObject | string,
  now: Date,
  maxSkewSeconds = MAX_CLOCK_SKEW_SECONDS,
): VerificationResult {
  if (!input.timestamp || !input.signature) return { ok: false, reason: 'missing_headers' };
  const ts = Date.parse(input.timestamp);
  if (Number.isNaN(ts)) return { ok: false, reason: 'invalid_timestamp' };
  if (Math.abs(now.getTime() - ts) > maxSkewSeconds * 1000)
    return { ok: false, reason: 'clock_skew' };
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  const message = Buffer.from(
    canonicalString(input.method, input.pathWithQuery, input.timestamp, input.body),
    'utf8',
  );
  let valid = false;
  try {
    valid = verify(null, message, key, Buffer.from(input.signature, 'base64'));
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: 'invalid_signature' };
}

/** Client-side helper (tests, simulators, TS tooling). Returns the three signing headers. */
export function signDeviceRequest(params: {
  deviceId: string;
  privateKey: KeyObject | string;
  method: string;
  pathWithQuery: string;
  body?: Buffer | string;
  timestamp?: string;
}): Record<string, string> {
  const timestamp = params.timestamp ?? new Date().toISOString();
  const key =
    typeof params.privateKey === 'string' ? createPrivateKey(params.privateKey) : params.privateKey;
  const message = canonicalString(
    params.method,
    params.pathWithQuery,
    timestamp,
    params.body ?? '',
  );
  return {
    'X-Device-Id': params.deviceId,
    'X-Device-Timestamp': timestamp,
    'X-Device-Signature': sign(null, Buffer.from(message, 'utf8'), key).toString('base64'),
  };
}

export interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  credentialStatus: 'active' | 'revoked' | 'decommissioned';
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    device?: DeviceIdentity;
  }
}

export interface DeviceAuthOptions {
  lookup(deviceId: string): Promise<DeviceIdentity | undefined>;
  now(): Date;
  maxSkewSeconds?: number;
}

/**
 * Fastify preHandler that authenticates a signed device request. Requires the raw body to be
 * captured in `request.rawBody` (see `registerRawJsonParser`). If the route has an `:id` param,
 * it must match the authenticated device.
 */
export function createDeviceAuthHook(options: DeviceAuthOptions): preHandlerAsyncHookHandler {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const deviceId = headerValue(request, HEADER_DEVICE_ID);
    if (!deviceId) throw unauthorized('device_auth_required', 'Missing X-Device-Id header');
    const identity = await options.lookup(deviceId);
    if (!identity) throw unauthorized('unknown_device', 'Device is not registered');
    if (identity.credentialStatus !== 'active') {
      throw forbidden('device_revoked', `Device credentials are ${identity.credentialStatus}`);
    }
    const result = verifySignedRequest(
      {
        method: request.method,
        pathWithQuery: request.url,
        timestamp: headerValue(request, HEADER_TIMESTAMP),
        signature: headerValue(request, HEADER_SIGNATURE),
        body: request.rawBody ?? Buffer.alloc(0),
      },
      identity.publicKeyPem,
      options.now(),
      options.maxSkewSeconds,
    );
    if (!result.ok)
      throw unauthorized(result.reason, `Device signature rejected: ${result.reason}`);
    const params = request.params as Record<string, unknown> | undefined;
    if (params && typeof params['id'] === 'string' && params['id'] !== deviceId) {
      throw forbidden(
        'device_mismatch',
        'Authenticated device does not match the requested resource',
      );
    }
    request.device = identity;
  };
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
