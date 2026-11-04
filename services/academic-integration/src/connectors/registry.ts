/** Builds a connector (with its authenticated HTTP client) from a stored configuration. */
import { BlackboardConnector } from './blackboard.js';
import { CanvasConnector } from './canvas.js';
import { EthosConnector } from './ethos.js';
import {
  ConnectorError,
  ConnectorHttp,
  EthosAuth,
  Lti13ClientAssertion,
  OAuth2ClientCredentials,
  QueryTokenAuth,
  StaticHeaderAuth,
  basicHeader,
  parseCredential,
  type AuthProvider,
  type HttpDeps,
} from './http.js';
import { MoodleConnector } from './moodle.js';
import type { SecretResolver } from './secrets.js';
import { TotvsRmConnector } from './totvs.js';
import { isLms, type Connector, type ConnectorConfig, type LmsConnector } from './types.js';

/** Default OAuth2 token endpoints per connector (overridable with `auth.tokenUrl`). */
const TOKEN_PATHS: Partial<Record<ConnectorConfig['type'], string>> = {
  blackboard: '/learn/api/public/v1/oauth2/token',
  canvas: '/login/oauth2/token',
  totvs_rm: '/api/connect/token',
};

export interface ConnectorFactory {
  create(config: ConnectorConfig): Promise<Connector>;
}

export class DefaultConnectorFactory implements ConnectorFactory {
  constructor(
    private readonly secrets: SecretResolver,
    private readonly http: HttpDeps,
  ) {}

  private async auth(config: ConnectorConfig): Promise<AuthProvider> {
    const { kind, secretRef, tokenUrl, scope } = config.auth;
    const credential = parseCredential(kind, await this.secrets.resolve(secretRef));
    const tokenEndpoint = tokenUrl ?? `${config.baseUrl}${TOKEN_PATHS[config.type] ?? '/oauth2/token'}`;
    if (config.type === 'banner' || config.type === 'colleague') {
      if (kind !== 'api_key') throw new ConnectorError('invalid_config', 'Ethos connectors use auth.kind api_key');
      return new EthosAuth(this.http, config.baseUrl, credential.apiKey ?? '');
    }
    switch (kind) {
      case 'api_key':
        return config.type === 'moodle'
          ? new QueryTokenAuth({ wstoken: credential.apiKey ?? '' })
          : new StaticHeaderAuth({ authorization: `Bearer ${credential.apiKey ?? ''}` });
      case 'basic':
        return new StaticHeaderAuth({ authorization: basicHeader(credential.username ?? '', credential.password ?? '') });
      case 'oauth2_client_credentials':
        return new OAuth2ClientCredentials(this.http, tokenEndpoint, credential.clientId ?? '', credential.clientSecret ?? '', scope);
      case 'lti13':
        if (!tokenUrl) throw new ConnectorError('invalid_config', 'lti13 requires auth.tokenUrl (platform token endpoint)');
        return new Lti13ClientAssertion(this.http, tokenUrl, credential.clientId ?? '', credential.privateKeyPem ?? '', credential.keyId, scope);
    }
  }

  async create(config: ConnectorConfig): Promise<Connector> {
    if (config.type === 'moodle' && config.auth.kind !== 'api_key')
      throw new ConnectorError('invalid_config', 'Moodle web services use auth.kind api_key (wstoken)');
    const http = new ConnectorHttp(config.baseUrl, await this.auth(config), this.http);
    switch (config.type) {
      case 'totvs_rm':
        return new TotvsRmConnector(config, http);
      case 'banner':
      case 'colleague':
        return new EthosConnector(config.type, config, http);
      case 'moodle':
        return new MoodleConnector(config, http);
      case 'canvas':
        return new CanvasConnector(config, http);
      case 'blackboard':
        return new BlackboardConnector(config, http);
    }
  }
}

export function isLmsConnector(c: Connector): c is LmsConnector {
  return isLms(c.type) && 'publishAnnouncement' in c;
}
