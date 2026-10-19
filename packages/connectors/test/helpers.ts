import { createHash } from 'node:crypto';
import type { Provider } from '@futuregrow/contracts';
import { FixtureServer } from '../../../test/helpers/fixture-server.js';
import { HttpClient } from '../src/http.js';
import { type ConnectorContext, DEFAULT_API_VERSIONS, DEFAULT_ENDPOINTS, type ProviderCredentials } from '../src/types.js';

export { FixtureServer };

export function makeCtx(server: FixtureServer, credentials: ProviderCredentials, opts: { externalAccountId?: string; metadata?: Record<string, unknown>; appAudited?: boolean | null } = {}): ConnectorContext {
  const b = server.baseUrl;
  return {
    http: new HttpClient({ maxRetries: 2, baseBackoffMs: 1 }),
    credentials,
    connection: {
      id: '00000000-0000-4000-8000-0000000000cc',
      provider: credentials.provider as Provider,
      externalAccountId: opts.externalAccountId ?? 'acct',
      metadata: opts.metadata ?? {},
      appAudited: opts.appAudited ?? null,
    },
    endpoints: {
      ...DEFAULT_ENDPOINTS,
      metaGraph: b,
      googleAds: b,
      googleOAuth: `${b}/oauth/token`,
      tiktok: b,
      youtubeData: `${b}/youtube/v3`,
      youtubeUpload: `${b}/upload/youtube/v3`,
      appStoreConnect: b,
      resend: b,
      searchConsole: `${b}/webmasters/v3`,
      shopifyOverride: b,
    },
    versions: DEFAULT_API_VERSIONS,
    now: () => new Date('2026-10-19T12:00:00Z'),
    loadAsset: async () => {
      const bytes = new TextEncoder().encode('fake-mp4-bytes-for-contract-test');
      return { bytes, mime: 'video/mp4', sha256: createHash('sha256').update(bytes).digest('hex'), publicUrl: `${b}/media/asset.mp4` };
    },
    sleep: async () => {},
  };
}

export const META = { id: 'm1', idempotencyKey: 'idem-key-0001' };
export const meta = { actionId: META.id, idempotencyKey: META.idempotencyKey };
