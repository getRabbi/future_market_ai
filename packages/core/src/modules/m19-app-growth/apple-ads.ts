import { type HttpClient, ProviderHttpError } from '@futuregrow/connectors';
import { appInstalls, evidenceRecords, withTenant } from '@futuregrow/db';
import { FgError, invalid, sha256Hex } from '@futuregrow/observability';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type CoreDeps, systemActor } from '../../deps.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { analyticsStateAllowsProcessing } from './index.js';

export const APPLE_ATTRIBUTION_ENDPOINT = 'https://api-adservices.apple.com/api/v1/';
const ApplePayload = z.object({
  attribution: z.boolean(),
  orgId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  campaignId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  adGroupId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  conversionType: z.string().max(40).optional(),
  claimType: z.string().max(40).optional(),
});
export type AppleAttribution = z.infer<typeof ApplePayload>;
export interface AppleAttributionProvider {
  resolve(token: string): Promise<AppleAttribution>;
}

/** Official AdServices API: tokens expire after 24 hours; a premature 404 is retried at most twice. */
export function appleAttributionProvider(http: HttpClient, sleep: (ms: number) => Promise<void>): AppleAttributionProvider {
  return {
    async resolve(token) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await http.request({ method: 'POST', url: APPLE_ATTRIBUTION_ENDPOINT, headers: { 'content-type': 'text/plain' }, body: token, timeoutMs: 10_000, maxResponseBytes: 32_000 });
          if (r.status !== 200) throw new FgError('PROVIDER_UNAVAILABLE', 'Apple attribution did not return a record', 503);
          const value = ApplePayload.safeParse(r.data);
          if (!value.success) throw new FgError('PROVIDER_UNAVAILABLE', 'Apple attribution returned an unsupported payload', 503);
          return value.data;
        } catch (err) {
          if (err instanceof ProviderHttpError && err.status === 404 && attempt < 2) {
            await sleep(5000);
            continue;
          }
          if (err instanceof ProviderHttpError && [400, 401, 403].includes(err.status ?? 0)) throw invalid('Apple attribution token is invalid, expired, or not permitted; request a fresh token on-device');
          throw new FgError('PROVIDER_UNAVAILABLE', 'Apple attribution unavailable; retry with a valid token before its 24-hour expiry', 503);
        }
      }
      throw new FgError('PROVIDER_UNAVAILABLE', 'Apple attribution unavailable', 503);
    },
  };
}

export const AppleAttributionRequest = z
  .object({
    appId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,199}$/),
    installId: z.string().min(8).max(200),
    token: z
      .string()
      .min(16)
      .max(16_000)
      .regex(/^[A-Za-z0-9+/=_-]+$/),
    consent: z.object({ analytics: z.boolean() }),
  })
  .strict();

/** Attach provider evidence to an existing consented iOS installation; never infer from aggregate reports. */
export async function reconcileAppleAttribution(deps: CoreDeps, tenantId: string, source: string, raw: unknown, provider?: AppleAttributionProvider) {
  const input = AppleAttributionRequest.parse(raw);
  if (!input.consent.analytics) return { recorded: false, status: 'consent_denied' };
  const hash = sha256Hex(`${tenantId}:ios:${input.appId}:${input.installId}`);
  const tokenHash = sha256Hex(`${tenantId}:${input.token}`);
  const uri = `apple-adservices://${tokenHash}`;
  const tctx = { tenantId, actor: 'system:apple-attribution' };
  const check = async (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => {
    const [install] = await tx
      .select()
      .from(appInstalls)
      .where(and(eq(appInstalls.platform, 'ios'), eq(appInstalls.appId, input.appId), eq(appInstalls.installId, hash)));
    if (!install || install.ingestionSource !== source) throw invalid('installation must be recorded by this authenticated backend first');
    if (!install.consentAnalytics || !install.profileId || !(await analyticsStateAllowsProcessing(tx, install.profileId, deps.clock.now()))) throw invalid('installation analytics consent is unavailable or withdrawn');
    return install;
  };
  const first = await withTenant(deps.db, tctx, check);
  if (first.attributionMethod === 'apple_ads_adservices') return { recorded: false, status: 'already_attributed', campaign: first.campaignRef };
  const api = provider ?? appleAttributionProvider(deps.http, deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))));
  const response = ApplePayload.parse(await api.resolve(input.token));
  // Apple's documented developer-mode payload is not real campaign evidence.
  if (response.orgId === 1234567890 || response.campaignId === 1234567890) return { recorded: false, status: 'test_payload' };
  if (response.attribution && (!response.orgId || !response.campaignId)) return { recorded: false, status: 'campaign_unavailable' };
  return withTenant(deps.db, tctx, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`apple-token:${tenantId}:${tokenHash}`}, 0))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:ios:${hash}`}, 0))`);
    const install = await check(tx);
    const [seen] = await tx.select().from(evidenceRecords).where(eq(evidenceRecords.sourceUriOrObjectId, uri));
    if (seen) {
      if ((seen.content as { installHash?: string } | null)?.installHash !== hash) throw invalid('attribution token was already reconciled to another installation');
      return { recorded: false, status: 'already_reconciled', campaign: install.campaignRef };
    }
    if (install.attributionMethod === 'apple_ads_adservices') return { recorded: false, status: 'already_attributed', campaign: install.campaignRef };
    const campaign = response.attribution ? `apple_ads:${response.orgId}:${response.campaignId}` : null;
    const ev = await admitInternalEvidence(tx, tenantId, systemActor('apple-attribution'), {
      kind: 'observation',
      sourceType: 'primary',
      owner: 'Apple AdServices',
      uri,
      content: { appId: input.appId, installHash: hash, response, verification: 'apple_adservices_response', applicationBinding: 'authenticated_backend_report' },
      summary: response.attribution ? 'Apple AdServices returned an attributed campaign; application binding is supplied by the authenticated backend' : 'Apple AdServices returned no matching ad attribution; this is not proof of an organic install',
      confidence: 1,
      license: 'Apple AdServices API terms; consented first-party app measurement',
      pii: 'pseudonymous',
      lawfulBasis: 'consent',
      permittedUses: ['analytics'],
      parents: install.evidenceId ? [install.evidenceId] : [],
      now: deps.clock.now(),
    });
    if (campaign)
      await tx
        .update(appInstalls)
        .set({ attributionMethod: 'apple_ads_adservices', sourceRef: 'apple_ads', campaignRef: campaign, evidenceId: ev.evidenceId, referrer: { appleOrgId: String(response.orgId), appleCampaignId: String(response.campaignId), ...(response.adGroupId ? { appleAdGroupId: String(response.adGroupId) } : {}) } })
        .where(eq(appInstalls.id, install.id));
    return { recorded: true, status: campaign ? 'attributed' : 'not_attributed', campaign, evidenceId: ev.evidenceId };
  });
}
