/**
 * Web Push delivery: VAPID (RFC 8292) + payload encryption aes128gcm (RFC 8291 / RFC 8188),
 * implemented with `node:crypto` only.
 */
import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  createSign,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  data?: Record<string, unknown>;
}

export interface PushOptions {
  ttlSeconds?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  topic?: string;
}

export interface PushResult {
  statusCode: number;
  /** 404/410: the subscription is gone and must be deleted. */
  expired: boolean;
}

export interface PushSender {
  send(target: PushTarget, message: PushMessage, options?: PushOptions): Promise<PushResult>;
}

export const b64url = (buf: Buffer): string => buf.toString('base64url');
export const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url');

export interface VapidKeys {
  /** Uncompressed P-256 public key (65 bytes), base64url — the `applicationServerKey`. */
  publicKey: string;
  /** Private scalar d (32 bytes), base64url. */
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

function vapidPrivateKeyObject(keys: VapidKeys): KeyObject {
  const pub = fromB64url(keys.publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04)
    throw new Error('VAPID public key must be 65-byte uncompressed P-256');
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
      d: keys.privateKey,
    },
    format: 'jwk',
  });
}

/** ES256 JWT for the push service origin (RFC 8292 §2). */
export function buildVapidJwt(
  audience: string,
  subject: string,
  keys: VapidKeys,
  now: Date,
  expiresInSeconds = 12 * 3600,
): string {
  if (expiresInSeconds > 24 * 3600) throw new Error('VAPID JWT must expire within 24 h');
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(now.getTime() / 1000) + expiresInSeconds,
        sub: subject,
      }),
    ),
  );
  const signer = createSign('SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign({ key: vapidPrivateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64url(signature)}`;
}

export function vapidAuthorization(
  endpoint: string,
  subject: string,
  keys: VapidKeys,
  now: Date,
): string {
  const audience = new URL(endpoint).origin;
  return `vapid t=${buildVapidJwt(audience, subject, keys, now)}, k=${keys.publicKey}`;
}

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest();

/** HKDF with a single expand block (all outputs here are ≤ 32 bytes). */
const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer =>
  hmac(hmac(salt, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, length);

export interface EncryptOverrides {
  /** Test hooks: fixed salt / sender key pair for deterministic vectors. */
  salt?: Buffer;
  senderPrivateKey?: Buffer;
}

export const RECORD_SIZE = 4096;

/** RFC 8291 §3.4 + RFC 8188 single-record aes128gcm body. */
export function encryptPayload(
  target: PushTarget,
  plaintext: Buffer,
  overrides: EncryptOverrides = {},
): Buffer {
  const uaPublic = fromB64url(target.keys.p256dh);
  const authSecret = fromB64url(target.keys.auth);
  if (uaPublic.length !== 65) throw new Error('p256dh must be a 65-byte uncompressed P-256 key');
  if (authSecret.length !== 16) throw new Error('auth secret must be 16 bytes');
  if (plaintext.length > RECORD_SIZE - 17 - 86) throw new Error('push payload too large');

  const sender = createECDH('prime256v1');
  if (overrides.senderPrivateKey) sender.setPrivateKey(overrides.senderPrivateKey);
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = overrides.salt ?? randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext, cipher.getAuthTag()]);
}

export class WebPushSender implements PushSender {
  constructor(
    private readonly keys: VapidKeys,
    /** `mailto:` or `https:` contact (RFC 8292 `sub`). */
    private readonly subject: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async send(
    target: PushTarget,
    message: PushMessage,
    options: PushOptions = {},
  ): Promise<PushResult> {
    const body = encryptPayload(target, Buffer.from(JSON.stringify(message), 'utf8'));
    const headers: Record<string, string> = {
      authorization: vapidAuthorization(target.endpoint, this.subject, this.keys, this.clock()),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(options.ttlSeconds ?? 24 * 3600),
      urgency: options.urgency ?? 'normal',
    };
    if (options.topic) headers.topic = options.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    const res = await this.fetchImpl(target.endpoint, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 || res.status === 410) return { statusCode: res.status, expired: true };
    if (!res.ok) throw new Error(`push service responded ${res.status}`);
    return { statusCode: res.status, expired: false };
  }
}

export class FakePushSender implements PushSender {
  readonly sent: { target: PushTarget; message: PushMessage; options: PushOptions }[] = [];
  /** endpoint → status to return (e.g. 410). */
  readonly statusByEndpoint = new Map<string, number>();
  send(target: PushTarget, message: PushMessage, options: PushOptions = {}): Promise<PushResult> {
    const status = this.statusByEndpoint.get(target.endpoint) ?? 201;
    if (status === 404 || status === 410)
      return Promise.resolve({ statusCode: status, expired: true });
    if (status >= 400) return Promise.reject(new Error(`push service responded ${status}`));
    this.sent.push({ target, message, options });
    return Promise.resolve({ statusCode: status, expired: false });
  }
}
