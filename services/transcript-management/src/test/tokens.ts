import { generateKeyPairSync, sign } from 'node:crypto';
import { createAccessTokenVerifier } from '../jwt-verify.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

export const verifier = createAccessTokenVerifier({ getKey: () => publicKey });

export function token(claims: { role: string; inst: string; sub: string; pid?: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' });
  const body = b64({
    iss: 'ci-identity',
    aud: 'ci',
    iat: now,
    exp: now + 900,
    jti: 'j',
    ...claims,
  });
  return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}
