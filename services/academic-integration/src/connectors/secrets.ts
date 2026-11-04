/**
 * Secret resolution for connector credentials. Configs store only a reference:
 *   `env:NAME`          → process environment (mounted from Secret Manager in Cloud Run)
 *   `gcp-sm:<resource>` → Secret Manager, resolved by an injected resolver (no SDK dependency here)
 */
import { ConnectorError } from './http.js';

export interface SecretResolver {
  resolve(ref: string): Promise<string>;
}

export class EnvSecretResolver implements SecretResolver {
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly fallback?: SecretResolver,
  ) {}
  resolve(ref: string): Promise<string> {
    if (ref.startsWith('env:')) {
      const value = this.env[ref.slice(4)];
      if (!value) return Promise.reject(new ConnectorError('secret_not_found', `${ref} is not set`));
      return Promise.resolve(value);
    }
    if (this.fallback) return this.fallback.resolve(ref);
    return Promise.reject(
      new ConnectorError('secret_backend_unavailable', `no resolver for ${ref.split(':')[0] ?? ref}`),
    );
  }
}

export class StaticSecretResolver implements SecretResolver {
  constructor(private readonly secrets: Record<string, string>) {}
  resolve(ref: string): Promise<string> {
    const v = this.secrets[ref];
    return v === undefined
      ? Promise.reject(new ConnectorError('secret_not_found', `${ref} is not available`))
      : Promise.resolve(v);
  }
}
