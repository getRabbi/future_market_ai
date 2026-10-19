import { DEFAULT_API_VERSIONS, DEFAULT_ENDPOINTS } from '@futuregrow/connectors';
import type { CoreConfig } from './deps.js';
import { parseSecretKeys } from './secrets.js';

export interface RuntimeEnv {
  NODE_ENV?: string;
  FG_SECRETS_KEY?: string;
  FG_SECRETS_KEY_VERSION?: string;
  FG_SECRETS_KEY_PREVIOUS?: string;
  FG_IDENTIFIER_PEPPER?: string;
  API_BASE_URL?: string;
  APP_BASE_URL?: string;
  META_GRAPH_API_VERSION?: string;
  GOOGLE_ADS_API_VERSION?: string;
  SHOPIFY_API_VERSION?: string;
  VERIFICATION_MAX_ATTEMPTS?: number | string;
  VERIFICATION_BASE_DELAY_SECONDS?: number | string;
}

export function buildCoreConfig(env: RuntimeEnv): CoreConfig {
  const { keys, current } = parseSecretKeys(env);
  if (!env.FG_IDENTIFIER_PEPPER) throw new Error('FG_IDENTIFIER_PEPPER is required');
  const environment = (['development', 'test', 'staging', 'production'].includes(env.NODE_ENV ?? '') ? env.NODE_ENV : 'development') as CoreConfig['environment'];
  return {
    identifierPepper: env.FG_IDENTIFIER_PEPPER,
    secretKeys: keys,
    currentSecretVersion: current,
    apiBaseUrl: env.API_BASE_URL ?? 'http://localhost:8080',
    appBaseUrl: env.APP_BASE_URL ?? 'http://localhost:4321',
    endpoints: DEFAULT_ENDPOINTS,
    versions: {
      ...DEFAULT_API_VERSIONS,
      meta: env.META_GRAPH_API_VERSION ?? DEFAULT_API_VERSIONS.meta,
      googleAds: env.GOOGLE_ADS_API_VERSION ?? DEFAULT_API_VERSIONS.googleAds,
      shopify: env.SHOPIFY_API_VERSION ?? DEFAULT_API_VERSIONS.shopify,
    },
    verification: {
      maxAttempts: Number(env.VERIFICATION_MAX_ATTEMPTS ?? 12),
      baseDelaySeconds: Number(env.VERIFICATION_BASE_DELAY_SECONDS ?? 15),
    },
    environment,
  };
}
