import type { ExecutionProof, ExecutionReceipt, Provider } from '@futuregrow/contracts';
import type { HttpClient } from './http.js';

/** Decrypted credentials. Exist only inside connector code at the execution boundary. */
export type ProviderCredentials =
  | { provider: 'meta'; accessToken: string; appSecret?: string; adsAccessToken?: string }
  | { provider: 'google_ads'; clientId: string; clientSecret: string; refreshToken: string; loginCustomerId?: string; developerToken?: string }
  | { provider: 'tiktok'; accessToken: string; openId?: string }
  | { provider: 'youtube'; clientId: string; clientSecret: string; refreshToken: string }
  | { provider: 'shopify'; shopDomain: string; accessToken: string }
  | { provider: 'app_store_connect'; issuerId: string; keyId: string; privateKeyPem: string; vendorNumber?: string }
  | { provider: 'resend'; apiKey: string }
  | { provider: 'posthog'; projectApiKey: string; host: string }
  | { provider: 'chatwoot'; baseUrl: string; apiAccessToken: string; accountId: string }
  | { provider: 'search_console'; clientId: string; clientSecret: string; refreshToken: string };

export interface ConnectionInfo {
  id: string;
  provider: Provider;
  externalAccountId: string;
  metadata: Record<string, unknown>;
  appAudited: boolean | null;
}

/** Base URLs are injectable so contract tests can target a local fixture server. */
export interface ProviderEndpoints {
  metaGraph: string;
  googleAds: string;
  googleOAuth: string;
  tiktok: string;
  youtubeData: string;
  youtubeUpload: string;
  appStoreConnect: string;
  resend: string;
  searchConsole: string;
  /** Shopify host override (tests); production uses https://{shop}.myshopify.com */
  shopifyOverride: string | null;
}

export const DEFAULT_ENDPOINTS: ProviderEndpoints = {
  metaGraph: 'https://graph.facebook.com',
  googleAds: 'https://googleads.googleapis.com',
  googleOAuth: 'https://oauth2.googleapis.com/token',
  tiktok: 'https://open.tiktokapis.com',
  youtubeData: 'https://www.googleapis.com/youtube/v3',
  youtubeUpload: 'https://www.googleapis.com/upload/youtube/v3',
  appStoreConnect: 'https://api.appstoreconnect.apple.com',
  resend: 'https://api.resend.com',
  searchConsole: 'https://www.googleapis.com/webmasters/v3',
  shopifyOverride: null,
};

export interface ApiVersions {
  meta: string;
  googleAds: string;
  shopify: string;
  tiktok: string;
  youtube: string;
  appStoreConnect: string;
}

export const DEFAULT_API_VERSIONS: ApiVersions = {
  meta: 'v26.0',
  googleAds: 'v26',
  shopify: '2026-10',
  tiktok: 'v2',
  youtube: 'v3',
  appStoreConnect: 'v1',
};

export interface AssetBytes {
  bytes: Uint8Array;
  mime: string;
  sha256: string;
  /** Short-lived URL the provider can pull from (TikTok PULL_FROM_URL, Instagram media_url). */
  publicUrl: string | null;
}

export interface ConnectorContext {
  http: HttpClient;
  credentials: ProviderCredentials;
  connection: ConnectionInfo;
  endpoints: ProviderEndpoints;
  versions: ApiVersions;
  now: () => Date;
  loadAsset: (assetId: string) => Promise<AssetBytes>;
  /** Polling delay hook (tests use 0). */
  sleep: (ms: number) => Promise<void>;
}

export interface ExecuteResult {
  receipt: ExecutionReceipt;
  /** Provider state observed immediately before the mutation (for rollback & diff). */
  beforeState: Record<string, unknown> | null;
  /** Full provider response, archived to object storage with its SHA-256. */
  rawResponse: unknown;
}

export interface ActionMeta {
  actionId: string;
  idempotencyKey: string;
}

/**
 * One executor per action type. `verify` must independently re-read provider state; it may
 * never infer success from the execute response alone (product plan: Verified execution only).
 */
export interface ActionExecutor<P = Record<string, unknown>> {
  actionType: string;
  provider: Provider;
  execute(ctx: ConnectorContext, params: P, meta: ActionMeta): Promise<ExecuteResult>;
  verify(ctx: ConnectorContext, params: P, receipt: ExecutionReceipt): Promise<ExecutionProof>;
  rollback?(ctx: ConnectorContext, params: P, receipt: ExecutionReceipt, beforeState: Record<string, unknown> | null): Promise<ExecuteResult>;
  verifyRollback?(ctx: ConnectorContext, params: P, receipt: ExecutionReceipt, beforeState: Record<string, unknown> | null): Promise<ExecutionProof>;
}

export interface SpendRow {
  campaignRef: string;
  date: string;
  currency: string;
  costMicros: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValueMicros: number;
}

export interface CampaignSnapshot {
  externalCampaignId: string;
  externalBudgetId: string | null;
  name: string;
  status: string;
  dailyBudgetMicros: number | null;
  currency: string | null;
  objective: string | null;
  raw: Record<string, unknown>;
}

export interface HealthResult {
  healthy: boolean;
  status: 'healthy' | 'degraded' | 'failing';
  grantedScopes: string[] | null;
  details: Record<string, unknown>;
}

/** Read-side operations (sync, reporting, health). */
export interface ReadConnector {
  provider: Provider;
  healthCheck(ctx: ConnectorContext): Promise<HealthResult>;
  listCampaigns?(ctx: ConnectorContext): Promise<CampaignSnapshot[]>;
  fetchSpend?(ctx: ConnectorContext, from: string, to: string): Promise<SpendRow[]>;
}

export function proof(verdict: ExecutionProof['verdict'], method: ExecutionProof['method'], expected: Record<string, unknown>, observed: Record<string, unknown> | null, now: Date, notes: string | null = null): ExecutionProof {
  const diff: ExecutionProof['diff'] = [];
  if (observed) {
    for (const [k, v] of Object.entries(expected)) {
      const o = observed[k];
      if (JSON.stringify(o) !== JSON.stringify(v)) diff.push({ path: k, expected: v, observed: o });
    }
  }
  return { verdict, method, expected, observed, diff, checkedAt: now.toISOString(), notes };
}

/** Compare expected vs observed and pick VERIFIED or MISMATCH. */
export function compareProof(method: ExecutionProof['method'], expected: Record<string, unknown>, observed: Record<string, unknown>, now: Date, notes: string | null = null): ExecutionProof {
  const p = proof('VERIFIED', method, expected, observed, now, notes);
  return p.diff.length === 0 ? p : { ...p, verdict: 'MISMATCH' };
}
