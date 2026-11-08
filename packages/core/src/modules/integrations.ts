import { CAPABILITY_SEEDS } from '@futuregrow/connectors';
import { getActionType } from '@futuregrow/contracts';
import { connections, type DbOrTx, platformCapabilities, storeAccounts } from '@futuregrow/db';
import { platformReadiness } from './m16-social/platforms.js';
import { complianceChecklist } from './m24-governance/compliance.js';

/**
 * Integration status (P2, Milestone A): one honest answer per external integration to "can
 * FUTUREGROW use this for my organization right now, and if not, what is missing?". A status is
 * derived only from persisted facts (connections and their last health check, the capability
 * registry, action-type support, verified posts, store accounts); nothing is reported as working
 * on the strength of code alone. `live_verified` needs independent evidence (a verified post or a
 * healthy store account with a successful sync); `connected` means a healthy connection without
 * that evidence yet.
 */

export const INTEGRATION_STATUSES = ['live_verified', 'connected', 'connection_unhealthy', 'requires_connection', 'requires_provider_approval', 'requires_owner_authorization', 'requires_legal_review', 'requires_paid_infrastructure', 'owner_assisted'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export interface IntegrationConnectionView {
  id: string;
  displayName: string;
  status: string;
  healthStatus: string;
  lastHealthCheckAt: string | null;
}

export interface IntegrationView {
  key: string;
  workstream: string;
  name: string;
  modules: string[];
  provider: string | null;
  status: IntegrationStatus;
  /** One sentence: what works or what blocks it. */
  summary: string;
  reasons: string[];
  /** What the owner does next, in order. */
  setup: string[];
  docsUrl: string | null;
  connections: IntegrationConnectionView[];
  capabilities: { capability: string; supported: boolean }[];
  /** Consequential writes (posting, sending, spending) this integration can perform through M23 once ready. */
  writes: { actionType: string; supported: boolean; blocker: string | null }[];
}

interface Spec {
  key: string;
  workstream: string;
  name: string;
  modules: string[];
  provider: string | null;
  docsUrl: string | null;
  setup: string[];
  actionTypes: string[];
}

const SPECS: Spec[] = [
  {
    key: 'app_store_connect',
    workstream: 'P2-01',
    name: 'App Store Connect',
    modules: ['M19', 'M18'],
    provider: 'app_store_connect',
    docsUrl: 'https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api',
    setup: [
      'In App Store Connect › Users and Access › Integrations, create a team API key with the Sales and Reports role (Admin once, to request Analytics Reports).',
      'Add the developer account in Apps › Developer accounts with the issuer id, key id, private key and vendor number.',
      'Confirm the discovered apps; the daily sync then imports sales and analytics reports.',
    ],
    actionTypes: ['store.app_store.update_localization'],
  },
  {
    key: 'instagram',
    workstream: 'P2-02',
    name: 'Instagram',
    modules: ['M16'],
    provider: 'meta',
    docsUrl: 'https://developers.facebook.com/docs/instagram-platform/content-publishing',
    setup: ['Link an Instagram professional account to the connected Facebook Page in Meta Business Suite.', 'Authorize the Meta app with instagram_basic and instagram_content_publish (App Review for public use).', 'Record the Instagram user id (igUserId) on the Page connection.'],
    actionTypes: ['social.instagram.publish_media'],
  },
  {
    key: 'tiktok',
    workstream: 'P2-03',
    name: 'TikTok',
    modules: ['M16'],
    provider: 'tiktok',
    docsUrl: 'https://developers.tiktok.com/doc/content-posting-api-get-started',
    setup: ['Create a TikTok developer app with the Content Posting API and the video.publish scope.', 'Connect the creator account with a user access token.', 'Until TikTok audits the app, every post is private (SELF_ONLY).'],
    actionTypes: ['social.tiktok.publish_video'],
  },
  {
    key: 'youtube',
    workstream: 'P2-04',
    name: 'YouTube',
    modules: ['M16'],
    provider: 'youtube',
    docsUrl: 'https://developers.google.com/youtube/v3/guides/uploading_a_video',
    setup: ['Create an OAuth client in a Google Cloud project with the YouTube Data API enabled.', 'Authorize the channel owner with youtube.upload and youtube.readonly and store the refresh token.', 'Unverified API projects can only upload private videos; request an audit for public uploads.'],
    actionTypes: ['social.youtube.upload_video'],
  },
  {
    key: 'linkedin',
    workstream: 'P2-05',
    name: 'LinkedIn',
    modules: ['M16'],
    provider: 'linkedin',
    docsUrl: 'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview',
    setup: ['Request the Community Management API product for the LinkedIn developer app (verified organization website and Page).', 'Connect with a member who is ADMINISTRATOR or CONTENT_ADMIN of the organization.', 'Mark the connection audited once LinkedIn grants the product.'],
    actionTypes: ['social.linkedin.publish_post'],
  },
  {
    key: 'x',
    workstream: 'P2-06',
    name: 'X',
    modules: ['M16'],
    provider: 'x',
    docsUrl: 'https://docs.x.com/x-api/getting-started/pricing',
    setup: ['Decide whether to pay for X API posting (pay-per-use, no free posting tier).', 'Create an X developer app with OAuth 2.0 user tokens (tweet.write, media.write) and connect the account.', 'A platform operator then marks x_post_create supported; posting stays behind M23 approvals and spend limits.'],
    actionTypes: ['social.x.publish_post'],
  },
  {
    key: 'reddit',
    workstream: 'P2-07',
    name: 'Reddit',
    modules: ['M16'],
    provider: null,
    docsUrl: 'https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki',
    setup: ['Record each community’s rules and allowed posting windows in the community workspace.', 'Prepare a share kit per community, review it, post it yourself where the rules allow, and record the post.'],
    actionTypes: [],
  },
  {
    key: 'google_ads',
    workstream: 'P2-08',
    name: 'Google Ads',
    modules: ['M17'],
    provider: 'google_ads',
    docsUrl: 'https://developers.google.com/google-ads/api/docs/get-started/introduction',
    setup: ['Apply for a developer token (Basic access or higher) in the manager account’s API Center.', 'Create an OAuth client and authorize a user with access to the customer account (adwords scope).', 'Connect the customer id (and the manager id when access goes through an MCC).'],
    actionTypes: ['ads.google.update_campaign_budget', 'ads.google.set_campaign_status', 'ads.google.create_campaign'],
  },
  {
    key: 'shopify',
    workstream: 'P2-09',
    name: 'Shopify',
    modules: ['M12', 'M22'],
    provider: 'shopify',
    docsUrl: 'https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin',
    setup: ['Create a custom app in the Shopify admin with read_orders, read_products, read_discounts and write_discounts.', 'Connect the shop domain with the Admin API access token.', 'Subscribe the orders/create, orders/paid and refunds/create webhooks to FUTUREGROW (signed with the app secret).'],
    actionTypes: ['commerce.shopify.create_discount'],
  },
  {
    key: 'resend',
    workstream: 'P2-10',
    name: 'Resend email',
    modules: ['M20'],
    provider: 'resend',
    docsUrl: 'https://resend.com/docs/dashboard/domains/introduction',
    setup: ['Create a Resend account and an API key with sending access.', 'Add the sending domain and publish the SPF and DKIM records Resend lists; publish a DMARC record too.', 'Record the sender identity and postal address in Governance; templates and journeys then need approval before sending.'],
    actionTypes: ['email.send'],
  },
  {
    key: 'posthog',
    workstream: 'P2-11',
    name: 'PostHog',
    modules: ['M02'],
    provider: 'posthog',
    docsUrl: 'https://posthog.com/docs/api/capture',
    setup: ['Optional: FUTUREGROW’s own event store works without PostHog.', 'Connect the PostHog project API key and host (e.g. https://eu.i.posthog.com).', 'Turn on forwarding: only events with analytics consent are sent, with a hashed id.'],
    actionTypes: [],
  },
  {
    key: 'chatwoot',
    workstream: 'P2-12',
    name: 'Chatwoot',
    modules: ['M21'],
    provider: 'chatwoot',
    docsUrl: 'https://www.chatwoot.com/developers/api/',
    setup: ['Create an agent access token in Chatwoot (Profile settings › Access token).', 'Connect the instance URL, account id and token, and record the inbox id that receives handoffs.', 'Add the FUTUREGROW webhook URL (with its secret token) in Chatwoot › Settings › Integrations › Webhooks for message_created.'],
    actionTypes: [],
  },
  {
    key: 'search_console',
    workstream: 'P2-13',
    name: 'Google Search Console',
    modules: ['M18'],
    provider: 'search_console',
    docsUrl: 'https://developers.google.com/webmaster-tools/v1/how-tos/authorizing',
    setup: ['Verify the property in Search Console.', 'Create an OAuth client and authorize a verified user with the webmasters.readonly scope.', 'Connect the exact property (https://example.com/ or sc-domain:example.com).'],
    actionTypes: [],
  },
  {
    key: 'payouts',
    workstream: 'P2-14',
    name: 'Creator & affiliate payouts',
    modules: ['M22'],
    provider: 'paypal',
    docsUrl: 'https://developer.paypal.com/docs/payouts/standard/',
    setup: [
      'Legal review of creator payouts (tax forms, KYC, payout restrictions per country) and a merchant agreement with the payout provider.',
      'Connect the payout provider account (PayPal Payouts) with sandbox credentials first.',
      'A platform operator enables the creator.payout action type; every payout still needs M23 approval with two-factor.',
    ],
    actionTypes: ['creator.payout'],
  },
];

const SOCIAL: Record<string, string> = { instagram: 'instagram', tiktok: 'tiktok', youtube: 'youtube', linkedin: 'linkedin', x: 'x' };
const DAY = 86_400_000;

function writesOf(spec: Spec) {
  return spec.actionTypes.map((t) => {
    const a = getActionType(t);
    return { actionType: t, supported: Boolean(a?.supported), blocker: a?.supported ? null : (a?.blockerRef ?? 'not registered') };
  });
}

export async function integrationCatalog(t: DbOrTx, now: Date): Promise<IntegrationView[]> {
  const [conns, caps, readiness, stores, legal] = await Promise.all([t.select().from(connections), t.select().from(platformCapabilities), platformReadiness(t, now), t.select().from(storeAccounts), complianceChecklist(t, now)]);
  const capsFor = (provider: string | null) => {
    if (!provider) return [];
    const platform = provider === 'paypal' ? 'paypal' : provider;
    const rows = caps.filter((c) => c.platform === platform);
    const seeds = CAPABILITY_SEEDS.filter((c) => c.platform === platform && !rows.some((r) => r.capability === c.capability));
    return [...rows, ...seeds].map((c) => ({ capability: c.capability, supported: c.supported }));
  };
  const out = SPECS.map((spec): IntegrationView => {
    const mine = spec.provider ? conns.filter((c) => c.provider === spec.provider) : [];
    const view = mine.map((c) => ({ id: c.id, displayName: c.displayName, status: c.status, healthStatus: c.healthStatus, lastHealthCheckAt: c.lastHealthCheckAt?.toISOString() ?? null }));
    const base = { key: spec.key, workstream: spec.workstream, name: spec.name, modules: spec.modules, provider: spec.provider, setup: spec.setup, docsUrl: spec.docsUrl, connections: view, capabilities: capsFor(spec.provider), writes: writesOf(spec) };
    const healthy = mine.filter((c) => c.status === 'active' && c.healthStatus === 'healthy');
    const usable = mine.filter((c) => c.status === 'active' && c.healthStatus !== 'failing');

    // Social platforms: reuse the platform readiness rules (D-042) so both views always agree.
    const social = SOCIAL[spec.key];
    if (social) {
      const r = readiness.find((x) => x.platform === social)!;
      const map: Record<string, IntegrationStatus> = {
        live_verified: 'live_verified',
        ready: 'connected',
        needs_connection: 'requires_connection',
        connection_unhealthy: 'connection_unhealthy',
        missing_permissions: 'requires_provider_approval',
        awaiting_approval: 'requires_provider_approval',
        needs_video: 'connected',
        disabled: spec.key === 'x' ? 'requires_owner_authorization' : 'requires_provider_approval',
        owner_assisted: 'owner_assisted',
      };
      const status = map[r.status] ?? 'requires_connection';
      const reasons = [...r.reasons];
      if (r.status === 'needs_video') reasons.push('Videos come from the Video Studio (Asset studio › Video); each upload is still approved through M23.');
      if (spec.key === 'x') reasons.push('Estimated provider cost: about $0.015 per post, $0.20 for a post with a link (docs.x.com pricing, checked 2026-11-04). FUTUREGROW never buys credits.');
      return { ...base, status, summary: reasons[0] ?? '', reasons };
    }
    if (spec.key === 'reddit') {
      const reasons = ['Reddit API access needs Reddit’s approval (and a contract for commercial use), and automated promotional posting would break most communities’ rules.', 'Share kits are prepared and reviewed here; you post them yourself and record what you posted.'];
      return { ...base, status: 'owner_assisted', summary: reasons[0]!, reasons };
    }
    if (spec.key === 'app_store_connect') {
      const accounts = stores.filter((s) => s.provider === 'app_store_connect');
      const okSynced = accounts.filter((a) => a.status === 'active' && a.healthStatus === 'ok' && a.lastSuccessAt && now.getTime() - a.lastSuccessAt.getTime() <= 3 * DAY);
      if (!accounts.length) return { ...base, status: 'requires_connection', summary: 'No App Store Connect key is connected, so no iOS report has been imported. iOS numbers show as not connected, never as zero.', reasons: ['requires_connection: add an App Store Connect API key in Apps › Developer accounts.'] };
      if (okSynced.length) return { ...base, status: 'live_verified', summary: `${okSynced.length} App Store Connect account${okSynced.length === 1 ? '' : 's'} synced successfully in the last 3 days.`, reasons: [] };
      const bad = accounts.find((a) => a.healthStatus !== 'ok' && a.healthStatus !== 'unknown');
      return bad
        ? { ...base, status: 'connection_unhealthy', summary: `The App Store Connect account "${bad.displayName}" reports ${bad.healthStatus.replaceAll('_', ' ')}.`, reasons: ['Open Apps › Developer accounts for the exact error and fix.'] }
        : { ...base, status: 'connected', summary: 'Connected; waiting for the first successful report import.', reasons: [] };
    }
    if (spec.key === 'payouts') {
      const reasons = ['Payout execution is disabled: no payout provider agreement, KYC and tax handling or legal approval is recorded (B-015).', 'Commission balances, clawbacks and payout requests are tracked; a recorded balance is never reported as paid.'];
      return { ...base, status: mine.length ? 'requires_legal_review' : 'requires_owner_authorization', summary: reasons[0]!, reasons };
    }
    if (!mine.length) return { ...base, status: 'requires_connection', summary: `${spec.name} is not connected.`, reasons: [] };
    if (!usable.length) return { ...base, status: 'connection_unhealthy', summary: 'Every connection is inactive or failing its health check; replace its credentials.', reasons: [] };
    if (spec.key === 'google_ads' && usable.every((c) => c.accessLevel === 'test')) {
      return { ...base, status: 'requires_provider_approval', summary: 'The developer token only has test-account access; apply for Basic access to read and change real accounts.', reasons: [] };
    }
    if (!healthy.length) return { ...base, status: 'connection_unhealthy', summary: 'Connected, but the last health check reported a problem (see the connection’s details).', reasons: [] };
    return { ...base, status: 'connected', summary: `Connected and healthy (${healthy.length} connection${healthy.length === 1 ? '' : 's'}). Live use is verified only by a successful sync or a verified action.`, reasons: [] };
  });
  // P2-15: legal, policy and licensing readiness (a review registry, not a connection).
  const open = legal.items.filter((i) => i.status !== 'approved');
  out.push({
    key: 'legal_readiness',
    workstream: 'P2-15',
    name: 'Legal, policy and licensing approvals',
    modules: ['M24'],
    provider: null,
    status: open.length ? 'requires_legal_review' : 'connected',
    summary: `${legal.approved} of ${legal.total} reviews approved by counsel or the owner.`,
    reasons: open.map((i) => `${i.title}: ${i.status.replaceAll('_', ' ')}; gates ${i.gates.join(', ')}`),
    setup: ['Governance › Legal & licensing: record each review with the reviewer, the document and its evidence.', 'Approvals expire (12 months, research 6 months) and must be renewed.', legal.note],
    docsUrl: null,
    connections: [],
    capabilities: [],
    writes: [],
  });
  return out;
}
