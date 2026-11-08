import type { Provider } from '@futuregrow/contracts';
import { appStoreRead, appStoreUpdateLocalization } from './providers/apple.js';
import { googleAdsRead, googleSetCampaignStatus, googleUpdateCampaignBudget } from './providers/google.js';
import { googlePlayRead } from './providers/google-play.js';
import { linkedinPublishPost, linkedinRead } from './providers/linkedin.js';
import { facebookPublishPost, facebookReplyComment, instagramPublishMedia, metaRead, metaSetCampaignStatus, metaUpdateCampaignBudget } from './providers/meta.js';
import { chatwootRead, posthogRead, searchConsoleRead } from './providers/misc.js';
import { resendRead, resendSendEmail } from './providers/resend.js';
import { shopifyCreateDiscount, shopifyRead } from './providers/shopify.js';
import { tiktokPublishVideo, tiktokRead } from './providers/tiktok.js';
import { xPublishPost, xRead } from './providers/x.js';
import { youtubeRead, youtubeUploadVideo } from './providers/youtube.js';
import type { ActionExecutor, ReadConnector } from './types.js';

export * from './capabilities.js';
export * from './deprecations.js';
export * from './html.js';
export * from './http.js';
export {
  type AnalyticsAccessType,
  type AnalyticsReportRequest,
  appStoreConnectJwt,
  createAnalyticsReportRequest,
  downloadReportSegment,
  fetchSalesReport,
  listAnalyticsReportRequests,
  listAnalyticsReports,
  listAscApps,
  listInstanceSegments,
  listReportInstances,
  type ReportSegment,
  readLocalization,
} from './providers/apple.js';
export { clearGoogleTokenCache, gaqlSearch, googleAccessToken } from './providers/google.js';
export * from './providers/google-play.js';
export { fromLittle, toLittle } from './providers/linkedin.js';
export { fetchPageInsights, fetchPagePosts, fetchPageProfile, PAGE_INSIGHT_METRICS, PAGE_POST_METRICS, type PageInsightMetricResult, type PagePostCounter, type PagePostMetric, type PagePostObservation, type PageProfile } from './providers/meta.js';
export { type ChatwootInbox, chatwootCreateHandoff, chatwootListInboxes, chatwootPostMessage, type PosthogEvent, posthogCaptureBatch, searchConsoleQuery } from './providers/misc.js';
export * from './providers/money.js';
export type { ResolvedEmail } from './providers/resend.js';
export * from './robots.js';
export * from './ssrf.js';
export * from './types.js';
export * from './webhooks.js';

/** Registry of external executors. Internal action types are executed by @futuregrow/core. */
export const EXECUTORS: Record<string, ActionExecutor<never>> = Object.fromEntries(
  [facebookPublishPost, facebookReplyComment, instagramPublishMedia, metaUpdateCampaignBudget, metaSetCampaignStatus, googleUpdateCampaignBudget, googleSetCampaignStatus, tiktokPublishVideo, youtubeUploadVideo, linkedinPublishPost, xPublishPost, shopifyCreateDiscount, appStoreUpdateLocalization, resendSendEmail].map(
    (e) => [e.actionType, e as unknown as ActionExecutor<never>],
  ),
);

export const READ_CONNECTORS: Partial<Record<Provider, ReadConnector>> = {
  meta: metaRead,
  google_ads: googleAdsRead,
  tiktok: tiktokRead,
  youtube: youtubeRead,
  linkedin: linkedinRead,
  x: xRead,
  shopify: shopifyRead,
  app_store_connect: appStoreRead,
  google_play: googlePlayRead,
  resend: resendRead,
  posthog: posthogRead,
  chatwoot: chatwootRead,
  search_console: searchConsoleRead,
};
