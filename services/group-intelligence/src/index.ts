import pg from 'pg';
import { buildApp } from './app.js';
import {
  HttpAiUsageClient,
  HttpAnalyticsClient,
  HttpDeviceClient,
  HttpGatewayClient,
  HttpIncidentsClient,
  HttpOrganizationClient,
} from './clients.js';
import { createJwksAccessTokenVerifier } from './jwt-verify.js';
import { loadPricing } from './pricing.js';
import {
  BigQueryWarehouse,
  InMemoryWarehouse,
  PostgresWarehouse,
  type Warehouse,
} from './warehouse.js';

const env = process.env;
const authDisabled = env['AUTH_DISABLED'] === 'true';
const internalToken = env['INTERNAL_API_TOKEN'];
const opt = (k: string): { bearerToken: string } | Record<string, never> =>
  env[k] ? { bearerToken: env[k] } : {};

function warehouse(): Warehouse {
  if (env['WAREHOUSE'] === 'bigquery') {
    const projectId = env['BIGQUERY_PROJECT_ID'];
    const dataset = env['BIGQUERY_DATASET'];
    if (!projectId || !dataset)
      throw new Error('BIGQUERY_PROJECT_ID and BIGQUERY_DATASET are required');
    return new BigQueryWarehouse({
      projectId,
      dataset,
      ...(env['BIGQUERY_LOCATION'] ? { location: env['BIGQUERY_LOCATION'] } : {}),
    });
  }
  if (env['DATABASE_URL'])
    return new PostgresWarehouse(new pg.Pool({ connectionString: env['DATABASE_URL'] }));
  return new InMemoryWarehouse();
}

const app = buildApp({
  sources: {
    organization: new HttpOrganizationClient({
      baseUrl: env['ORGANIZATION_URL'] ?? 'http://localhost:4002',
    }),
    analytics: new HttpAnalyticsClient({
      baseUrl: env['ACADEMIC_ANALYTICS_URL'] ?? 'http://localhost:4009',
      ...opt('ANALYTICS_INTERNAL_TOKEN'),
    }),
    aiUsage: new HttpAiUsageClient({ baseUrl: env['AI_GATEWAY_URL'] ?? 'http://localhost:8005' }),
    devices: new HttpDeviceClient({
      baseUrl: env['DEVICE_MANAGEMENT_URL'] ?? 'http://localhost:4004',
      ...opt('DEVICE_MANAGEMENT_ADMIN_TOKEN'),
    }),
    incidents: new HttpIncidentsClient({
      baseUrl: env['NOTIFICATIONS_URL'] ?? 'http://localhost:4006',
      ...opt('NOTIFICATIONS_ADMIN_TOKEN'),
    }),
  },
  gateway: new HttpGatewayClient({ baseUrl: env['AI_GATEWAY_URL'] ?? 'http://localhost:8005' }),
  warehouse: warehouse(),
  pricing: loadPricing(env['PRICING_CONFIG_PATH']),
  auth: {
    disabled: authDisabled,
    ...(authDisabled
      ? {}
      : {
          verifier: createJwksAccessTokenVerifier({
            jwksUrl: env['IDENTITY_JWKS_URL'] ?? 'http://localhost:4001/.well-known/jwks.json',
          }),
        }),
    ...(internalToken ? { internalToken } : {}),
  },
  defaultHoldingCompanyIds: (env['GROUP_HOLDING_COMPANY_IDS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  ...(env['INVESTIGATION_BILLING_INSTITUTION_ID']
    ? { investigationBillingInstitutionId: env['INVESTIGATION_BILLING_INSTITUTION_ID'] }
    : {}),
  logger: true,
});

if (authDisabled) app.log.warn('AUTH_DISABLED=true — group views are open (development only)');
if (!internalToken)
  app.log.warn('INTERNAL_API_TOKEN unset — pipeline endpoints are closed unless AUTH_DISABLED');

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: Number(env['PORT'] ?? 4010), host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

void start();
