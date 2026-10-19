import type { Provider } from '@futuregrow/contracts';
import { appStoreRead, appStoreUpdateLocalization } from './providers/apple.js';
import { googleAdsRead, googleSetCampaignStatus, googleUpdateCampaignBudget } from './providers/google.js';
import { facebookPublishPost, facebookReplyComment, instagramPublishMedia, metaRead, metaSetCampaignStatus, metaUpdateCampaignBudget } from './providers/meta.js';
import { resendRead, resendSendEmail } from './providers/resend.js';
import { shopifyCreateDiscount, shopifyRead } from './providers/shopify.js';
import { tiktokPublishVideo, tiktokRead } from './providers/tiktok.js';
import { youtubeRead, youtubeUploadVideo } from './providers/youtube.js';
import type { ActionExecutor, ReadConnector } from './types.js';

export * from './types.js';
export * from './http.js';
export * from './ssrf.js';
export * from './robots.js';
export * from './capabilities.js';
export * from './webhooks.js';
export * from './providers/money.js';
export { appStoreConnectJwt, fetchSalesReport } from './providers/apple.js';
export { googleAccessToken, gaqlSearch, clearGoogleTokenCache } from './providers/google.js';
export { searchConsoleQuery, posthogCaptureBatch, chatwootCreateHandoff } from './providers/misc.js';
export type { ResolvedEmail } from './providers/resend.js';

/** Registry of external executors. Internal action types are executed by @futuregrow/core. */
export const EXECUTORS: Record<string, ActionExecutor<never>> = Object.fromEntries(
  [
    facebookPublishPost,
    facebookReplyComment,
    instagramPublishMedia,
    metaUpdateCampaignBudget,
    metaSetCampaignStatus,
    googleUpdateCampaignBudget,
    googleSetCampaignStatus,
    tiktokPublishVideo,
    youtubeUploadVideo,
    shopifyCreateDiscount,
    appStoreUpdateLocalization,
    resendSendEmail,
  ].map((e) => [e.actionType, e as unknown as ActionExecutor<never>]),
);

export const READ_CONNECTORS: Partial<Record<Provider, ReadConnector>> = {
  meta: metaRead,
  google_ads: googleAdsRead,
  tiktok: tiktokRead,
  youtube: youtubeRead,
  shopify: shopifyRead,
  app_store_connect: appStoreRead,
  resend: resendRead,
};
