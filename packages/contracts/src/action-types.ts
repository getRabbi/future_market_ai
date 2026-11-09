import { z } from 'zod';
import type { Provider, RiskCategory, VerificationMethod } from './enums.js';

/**
 * Deny-by-default allowlist of consequential write actions (M23). An action type that is not
 * listed here cannot be proposed, approved or executed. `supported: false` entries document
 * capabilities that the product needs but that are blocked (vendor unspecified, legal review
 * outstanding); the policy engine always DENIES them.
 */
export interface ActionTypeDefinition {
  type: string;
  provider: Provider;
  capability: string;
  category: RiskCategory;
  description: string;
  /** Whether a successful execution changes money flow (spend, discount, payout). */
  affectsSpend: boolean;
  /** Whether the result is visible to the public. */
  publicFacing: boolean;
  /** Whether the action contacts a person. */
  contactsPeople: boolean;
  /** Primary independent verification method for the postcondition. */
  verification: VerificationMethod;
  /** Whether the connector implements a compensating rollback. */
  rollback: 'supported' | 'manual' | 'impossible';
  supported: boolean;
  blockerRef?: string;
  /** Never pre-authorized, whatever the tenant autonomy policy says: a person approves every instance (e.g. creating paid campaigns, P3-06). */
  alwaysRequiresApproval?: boolean;
  paramsSchema: z.ZodType;
}

const money = z.object({ amountMicros: z.number().int().nonnegative(), currency: z.string().length(3) });

const disclosure = z.object({
  isAiGenerated: z.boolean(),
  paidPartnership: z.boolean(),
  syntheticPersonaId: z.string().uuid().nullable(),
  disclosureText: z.string().max(500).nullable(),
});

export const ACTION_TYPES = [
  {
    type: 'social.facebook.publish_post',
    provider: 'meta',
    capability: 'facebook_page_publish',
    category: 'PUBLIC_PUBLISHING',
    description: 'Publish a text, link or photo post (up to 10 images) to an authorized Facebook Page.',
    affectsSpend: false,
    publicFacing: true,
    contactsPeople: false,
    verification: 'read_after_write',
    rollback: 'supported',
    supported: true,
    paramsSchema: z
      .object({
        pageId: z.string().min(1),
        message: z.string().min(1).max(63206),
        link: z.string().url().optional(),
        postId: z.string().uuid(),
        assetIds: z.array(z.string().uuid()).max(10).default([]),
        /** D-040: each image's content hash, so the action binds the exact bytes that are uploaded. */
        media: z
          .array(z.object({ assetId: z.string().uuid(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
          .max(10)
          .optional(),
        /** D-040: the verified curriculum unit the post teaches (M23 checks the message against it). */
        curriculum: z.object({ pack: z.string().min(1), version: z.string().min(1), unitId: z.string().min(1), revealUnitId: z.string().min(1).optional() }).optional(),
        claimIds: z.array(z.string().uuid()).default([]),
        disclosure,
      })
      .refine((p) => (p.media?.length ?? 0) === p.assetIds.length && (p.media ?? []).every((m, i) => m.assetId === p.assetIds[i]), 'media must list the assetIds in order with their content hashes')
      .refine((p) => !(p.link && p.assetIds.length), 'a photo post cannot also carry a link preview'),
  },
  {
    type: 'social.instagram.publish_media',
    provider: 'meta',
    capability: 'instagram_content_publish',
    category: 'PUBLIC_PUBLISHING',
    description: 'Publish an image, a reel or a carousel (2–10 images/videos) to an authorized Instagram professional account.',
    affectsSpend: false,
    publicFacing: true,
    contactsPeople: false,
    verification: 'status_poll',
    rollback: 'manual',
    supported: true,
    paramsSchema: z
      .object({
        igUserId: z.string().min(1),
        mediaType: z.enum(['IMAGE', 'REELS', 'CAROUSEL']),
        mediaUrl: z.string().url(),
        caption: z.string().max(2200),
        /** CAROUSEL only: the items in order, one per asset (asset:// references until execution). */
        items: z
          .array(z.object({ mediaType: z.enum(['IMAGE', 'VIDEO']), mediaUrl: z.string().url() }))
          .min(2)
          .max(10)
          .optional(),
        postId: z.string().uuid(),
        assetIds: z.array(z.string().uuid()).min(1).max(10),
        claimIds: z.array(z.string().uuid()).default([]),
        disclosure,
      })
      .refine((p) => (p.mediaType === 'CAROUSEL' ? p.items?.length === p.assetIds.length && p.assetIds.length >= 2 : !p.items && p.assetIds.length === 1), 'a carousel lists one item per asset (2–10); an image or reel has exactly one asset'),
  },
  {
    type: 'social.tiktok.publish_video',
    provider: 'tiktok',
    capability: 'tiktok_direct_post',
    category: 'PUBLIC_PUBLISHING',
    description: 'Direct Post a video via the TikTok Content Posting API (requires video.publish scope).',
    affectsSpend: false,
    publicFacing: true,
    contactsPeople: false,
    verification: 'status_poll',
    rollback: 'manual',
    supported: true,
    paramsSchema: z.object({
      title: z.string().max(2200),
      videoUrl: z.string().url(),
      privacyLevel: z.enum(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']),
      disableComment: z.boolean().default(false),
      disableDuet: z.boolean().default(false),
      disableStitch: z.boolean().default(false),
      brandContentToggle: z.boolean(),
      brandOrganicToggle: z.boolean(),
      postId: z.string().uuid(),
      assetIds: z.array(z.string().uuid()).min(1),
      claimIds: z.array(z.string().uuid()).default([]),
      disclosure,
    }),
  },
  {
    type: 'social.linkedin.publish_post',
    provider: 'linkedin',
    capability: 'linkedin_org_post',
    category: 'PUBLIC_PUBLISHING',
    description: 'Publish a text or image post as a LinkedIn organization (Posts API; needs the Community Management API product and w_organization_social).',
    affectsSpend: false,
    publicFacing: true,
    contactsPeople: false,
    verification: 'read_after_write',
    rollback: 'supported',
    supported: true,
    paramsSchema: z
      .object({
        authorUrn: z.string().regex(/^urn:li:organization:\d+$/),
        commentary: z.string().min(1).max(3000),
        postId: z.string().uuid(),
        assetIds: z.array(z.string().uuid()).max(20).default([]),
        media: z
          .array(z.object({ assetId: z.string().uuid(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
          .max(20)
          .optional(),
        claimIds: z.array(z.string().uuid()).default([]),
        disclosure,
      })
      .refine((p) => (p.media?.length ?? 0) === p.assetIds.length && (p.media ?? []).every((m, i) => m.assetId === p.assetIds[i]), 'media must list the assetIds in order with their content hashes'),
  },
  {
    type: 'social.x.publish_post',
    provider: 'x',
    capability: 'x_post_create',
    category: 'PUBLIC_PUBLISHING',
    description: 'Publish a post (up to 4 images) to an X account (API v2). X bills every post request (pay-per-use, no free tier), so this stays unsupported until the owner authorizes that spend.',
    affectsSpend: false,
    publicFacing: true,
    contactsPeople: false,
    verification: 'read_after_write',
    rollback: 'supported',
    supported: false,
    blockerRef: 'B-019',
    paramsSchema: z
      .object({
        text: z.string().min(1).max(4000),
        postId: z.string().uuid(),
        assetIds: z.array(z.string().uuid()).max(4).default([]),
        media: z
          .array(z.object({ assetId: z.string().uuid(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }))
          .max(4)
          .optional(),
        claimIds: z.array(z.string().uuid()).default([]),
        disclosure,
      })
      .refine((p) => (p.media?.length ?? 0) === p.assetIds.length && (p.media ?? []).every((m, i) => m.assetId === p.assetIds[i]), 'media must list the assetIds in order with their content hashes'),
  },
  {
    type: 'social.youtube.upload_video',
    provider: 'youtube',
    capability: 'youtube_video_upload',
    category: 'PUBLIC_PUBLISHING',
    description: 'Upload a video with the YouTube Data API (quota-controlled).',
    affectsSpend: false,
    publicFacing: true,
    contactsPeople: false,
    verification: 'read_after_write',
    rollback: 'supported',
    supported: true,
    paramsSchema: z.object({
      title: z.string().min(1).max(100),
      description: z.string().max(5000),
      privacyStatus: z.enum(['public', 'unlisted', 'private']),
      categoryId: z.string().default('22'),
      containsSyntheticMedia: z.boolean(),
      madeForKids: z.boolean(),
      postId: z.string().uuid(),
      assetIds: z.array(z.string().uuid()).length(1),
      claimIds: z.array(z.string().uuid()).default([]),
      disclosure,
    }),
  },
  {
    type: 'social.facebook.reply_comment',
    provider: 'meta',
    capability: 'facebook_page_comment_reply',
    category: 'PUBLIC_PUBLISHING',
    description: 'Reply to a comment on an authorized Facebook Page post.',
    affectsSpend: false,
    publicFacing: true,
    contactsPeople: true,
    verification: 'read_after_write',
    rollback: 'supported',
    supported: true,
    paramsSchema: z.object({
      commentId: z.string().min(1),
      message: z.string().min(1).max(8000),
      interactionId: z.string().uuid(),
      claimIds: z.array(z.string().uuid()).default([]),
    }),
  },
  {
    type: 'ads.google.update_campaign_budget',
    provider: 'google_ads',
    capability: 'google_ads_campaign_budget_mutate',
    category: 'SPEND',
    description: 'Change the daily amount of a Google Ads campaign budget.',
    affectsSpend: true,
    publicFacing: false,
    contactsPeople: false,
    verification: 'read_after_write',
    rollback: 'supported',
    supported: true,
    paramsSchema: z.object({
      customerId: z.string().regex(/^\d{10}$/),
      campaignBudgetId: z.string().regex(/^\d+$/),
      campaignRef: z.string().min(1),
      newDailyBudget: money,
      previousDailyBudget: money,
    }),
  },
  {
    type: 'ads.google.set_campaign_status',
    provider: 'google_ads',
    capability: 'google_ads_campaign_status_mutate',
    category: 'SPEND',
    description: 'Pause or enable a Google Ads campaign.',
    affectsSpend: true,
    publicFacing: false,
    contactsPeople: false,
    verification: 'read_after_write',
    rollback: 'supported',
    supported: true,
    paramsSchema: z.object({
      customerId: z.string().regex(/^\d{10}$/),
      campaignId: z.string().regex(/^\d+$/),
      status: z.enum(['PAUSED', 'ENABLED']),
      previousStatus: z.enum(['PAUSED', 'ENABLED']),
      dailyBudget: money,
    }),
  },
  {
    type: 'ads.meta.update_campaign_budget',
    provider: 'meta',
    capability: 'meta_ads_campaign_budget_update',
    category: 'SPEND',
    description: 'Change the daily budget of a Meta campaign (campaign budget optimisation).',
    affectsSpend: true,
    publicFacing: false,
    contactsPeople: false,
    verification: 'read_after_write',
    rollback: 'supported',
    supported: true,
    paramsSchema: z.object({
      campaignId: z.string().regex(/^\d+$/),
      newDailyBudget: money,
      previousDailyBudget: money,
    }),
  },
  {
    type: 'ads.meta.set_campaign_status',
    provider: 'meta',
    capability: 'meta_ads_campaign_status_update',
    category: 'SPEND',
    description: 'Pause or activate a Meta campaign.',
    affectsSpend: true,
    publicFacing: false,
    contactsPeople: false,
    verification: 'read_after_write',
    rollback: 'supported',
    supported: true,
    paramsSchema: z.object({
      campaignId: z.string().regex(/^\d+$/),
      status: z.enum(['PAUSED', 'ACTIVE']),
      previousStatus: z.enum(['PAUSED', 'ACTIVE']),
      dailyBudget: money,
    }),
  },
  {
    type: 'ads.meta.create_campaign',
    provider: 'meta',
    capability: 'meta_ads_campaign_create',
    category: 'SPEND',
    alwaysRequiresApproval: true,
    description: 'Create a complete Meta campaign (campaign, ad set, creative, ad), every level PAUSED; activation is a separate approved status change (P3-06).',
    affectsSpend: true,
    publicFacing: false,
    contactsPeople: false,
    verification: 'read_after_write',
    rollback: 'supported',
    supported: true,
    paramsSchema: z
      .object({
        adAccountId: z.string().regex(/^act_\d+$/),
        draftId: z.string().uuid(),
        name: z.string().min(1).max(150),
        objective: z.enum(['OUTCOME_AWARENESS', 'OUTCOME_TRAFFIC', 'OUTCOME_ENGAGEMENT', 'OUTCOME_LEADS', 'OUTCOME_APP_PROMOTION', 'OUTCOME_SALES']),
        dailyBudget: money,
        startTime: z.string().datetime({ offset: true }),
        endTime: z.string().datetime({ offset: true }),
        targeting: z.object({
          countries: z
            .array(z.string().regex(/^[A-Z]{2}$/))
            .min(1)
            .max(25),
          ageMin: z.number().int().min(18).max(65),
          ageMax: z.number().int().min(18).max(65),
          publisherPlatforms: z
            .array(z.enum(['facebook', 'instagram', 'audience_network', 'messenger']))
            .min(1)
            .nullable(),
        }),
        optimizationGoal: z.enum(['LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'REACH', 'IMPRESSIONS', 'POST_ENGAGEMENT']),
        billingEvent: z.literal('IMPRESSIONS'),
        creative: z.object({
          pageId: z.string().regex(/^\d+$/),
          message: z.string().min(1).max(2000),
          link: z.string().url().startsWith('https://'),
          headline: z.string().min(1).max(255),
          callToAction: z.enum(['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'DOWNLOAD', 'INSTALL_MOBILE_APP', 'CONTACT_US', 'SUBSCRIBE']),
          image: z.object({ assetId: z.string().uuid(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
        }),
        urlTags: z.string().max(500),
        /** The most the campaign can spend between start and end (daily budget x days); reserved against the spend envelope. */
        lifetimeCap: money,
        claimIds: z.array(z.string().uuid()).default([]),
        disclosure,
      })
      .refine((p) => p.targeting.ageMin <= p.targeting.ageMax, 'ageMin must not exceed ageMax')
      .refine((p) => Date.parse(p.endTime) > Date.parse(p.startTime), 'the campaign must end after it starts')
      .refine((p) => p.lifetimeCap.currency === p.dailyBudget.currency, 'cap and budget currencies differ'),
  },
  {
    type: 'ads.google.create_campaign',
    provider: 'google_ads',
    capability: 'google_ads_campaign_create',
    category: 'SPEND',
    alwaysRequiresApproval: true,
    description: 'Create a Google Ads Search campaign PAUSED with budget, targeting, ad group, keywords and a responsive search ad in one atomic mutate (P3-06).',
    affectsSpend: true,
    publicFacing: false,
    contactsPeople: false,
    verification: 'read_after_write',
    rollback: 'supported',
    supported: true,
    paramsSchema: z
      .object({
        customerId: z.string().regex(/^\d{10}$/),
        draftId: z.string().uuid(),
        name: z.string().min(1).max(200),
        dailyBudget: money,
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        geoTargetConstants: z.array(z.number().int().positive()).min(1).max(25),
        languageConstants: z.array(z.number().int().positive()).max(10).default([]),
        bidding: z.object({ strategy: z.enum(['MAXIMIZE_CLICKS', 'MANUAL_CPC']), cpcBidCeiling: money.nullable() }),
        adGroup: z.object({ name: z.string().min(1).max(255), cpcBid: money.nullable() }),
        ad: z.object({
          finalUrl: z.string().url().startsWith('https://'),
          finalUrlSuffix: z.string().max(500).nullable(),
          headlines: z.array(z.string().min(1).max(30)).min(3).max(15),
          descriptions: z.array(z.string().min(1).max(90)).min(2).max(4),
          path1: z.string().max(15).nullable(),
          path2: z.string().max(15).nullable(),
        }),
        keywords: z
          .array(z.object({ text: z.string().min(1).max(80), matchType: z.enum(['BROAD', 'PHRASE', 'EXACT']) }))
          .min(1)
          .max(50),
        lifetimeCap: money,
        claimIds: z.array(z.string().uuid()).default([]),
        disclosure,
      })
      .refine((p) => p.endDate >= p.startDate, 'the campaign must end on or after its start date')
      .refine((p) => p.lifetimeCap.currency === p.dailyBudget.currency, 'cap and budget currencies differ'),
  },
  {
    type: 'email.send',
    provider: 'resend',
    capability: 'email_send',
    category: 'MESSAGING',
    description: 'Send one email to one consented, unsuppressed recipient.',
    affectsSpend: false,
    publicFacing: false,
    contactsPeople: true,
    verification: 'status_poll',
    rollback: 'impossible',
    supported: true,
    paramsSchema: z.object({
      messageId: z.string().uuid(),
      profileId: z.string().uuid(),
      templateId: z.string().uuid(),
      category: z.enum(['transactional', 'commercial']),
      subject: z.string().min(1).max(998),
      claimIds: z.array(z.string().uuid()).default([]),
    }),
  },
  {
    type: 'commerce.shopify.create_discount',
    provider: 'shopify',
    capability: 'shopify_discount_create',
    category: 'PRICING',
    description: 'Create a Shopify basic discount code for an approved offer.',
    affectsSpend: true,
    publicFacing: true,
    contactsPeople: false,
    verification: 'read_after_write',
    rollback: 'supported',
    supported: true,
    paramsSchema: z.object({
      offerId: z.string().uuid(),
      title: z.string().min(1).max(255),
      code: z.string().regex(/^[A-Z0-9_-]{4,40}$/),
      percentage: z.number().gt(0).lte(1),
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime().nullable(),
      usageLimit: z.number().int().positive().nullable(),
    }),
  },
  {
    type: 'store.app_store.update_localization',
    provider: 'app_store_connect',
    capability: 'asc_version_localization_update',
    category: 'STORE_METADATA',
    description: 'Update App Store version localization metadata (description, keywords, promotional text).',
    affectsSpend: false,
    publicFacing: true,
    contactsPeople: false,
    verification: 'read_after_write',
    rollback: 'supported',
    supported: true,
    paramsSchema: z.object({
      listingId: z.string().uuid(),
      localizationId: z.string().min(1),
      fields: z.object({
        description: z.string().max(4000).optional(),
        keywords: z.string().max(100).optional(),
        promotionalText: z.string().max(170).optional(),
        whatsNew: z.string().max(4000).optional(),
      }),
      previousFields: z.record(z.string(), z.string().nullable()),
    }),
  },
  {
    type: 'experiment.start',
    provider: 'internal',
    capability: 'experiment_start',
    category: 'EXPERIMENT',
    description: 'Start an approved experiment (assignment begins).',
    affectsSpend: false,
    publicFacing: false,
    contactsPeople: false,
    verification: 'database_readback',
    rollback: 'supported',
    supported: true,
    paramsSchema: z.object({ experimentId: z.string().uuid() }),
  },
  {
    type: 'data.export_customer_data',
    provider: 'internal',
    capability: 'customer_data_export',
    category: 'DATA_EXPORT',
    description: 'Export customer data (DSAR access response or approved analytics export).',
    affectsSpend: false,
    publicFacing: false,
    contactsPeople: false,
    verification: 'database_readback',
    rollback: 'impossible',
    supported: true,
    paramsSchema: z.object({
      dsarId: z.string().uuid().nullable(),
      profileIds: z.array(z.string().uuid()).min(1).max(10000),
      purpose: z.string().min(3),
    }),
  },
  {
    type: 'sms.send',
    provider: 'internal',
    capability: 'sms_send',
    category: 'MESSAGING',
    description: 'Send SMS. Vendor unspecified [U].',
    affectsSpend: false,
    publicFacing: false,
    contactsPeople: true,
    verification: 'status_poll',
    rollback: 'impossible',
    supported: false,
    blockerRef: 'D-018',
    paramsSchema: z.object({}).passthrough(),
  },
  {
    type: 'whatsapp.send',
    provider: 'internal',
    capability: 'whatsapp_send',
    category: 'MESSAGING',
    description: 'Send WhatsApp message. Vendor unspecified [U].',
    affectsSpend: false,
    publicFacing: false,
    contactsPeople: true,
    verification: 'status_poll',
    rollback: 'impossible',
    supported: false,
    blockerRef: 'D-018',
    paramsSchema: z.object({}).passthrough(),
  },
  {
    type: 'creator.payout',
    provider: 'paypal',
    capability: 'creator_payout_create',
    category: 'PAYOUT',
    alwaysRequiresApproval: true,
    description: 'Pay a creator/affiliate through PayPal Payouts (P2-14). Disabled until legal review, a merchant agreement, KYC and tax handling exist.',
    affectsSpend: true,
    publicFacing: false,
    contactsPeople: false,
    verification: 'reconciliation',
    rollback: 'manual',
    supported: false,
    blockerRef: 'B-015',
    paramsSchema: z.object({
      payoutRequestId: z.string().uuid(),
      creatorId: z.string().uuid(),
      items: z
        .array(z.object({ itemId: z.string().min(1).max(30), receiver: z.string().email(), amountMicros: z.number().int().positive(), currency: z.string().length(3), note: z.string().max(4000) }))
        .min(1)
        .max(10),
    }),
  },
] as const satisfies readonly ActionTypeDefinition[];

export type ActionTypeName = (typeof ACTION_TYPES)[number]['type'];

const byType = new Map<string, ActionTypeDefinition>(ACTION_TYPES.map((a) => [a.type, a]));

export function getActionType(type: string): ActionTypeDefinition | undefined {
  return byType.get(type);
}

export function listActionTypes(): readonly ActionTypeDefinition[] {
  return ACTION_TYPES;
}

/**
 * Legal review domains of jurisdiction rule packs (D-037). A legal-approved pack makes its
 * jurisdiction approved only for the action types of its own domain; an action type outside
 * every domain is never covered, so it keeps needing legal approval.
 */
export const JURISDICTION_DOMAINS = {
  organic_social: ['social.facebook.publish_post', 'social.instagram.publish_media', 'social.tiktok.publish_video', 'social.youtube.upload_video', 'social.linkedin.publish_post', 'social.x.publish_post'],
  social_engagement: ['social.facebook.reply_comment'],
  advertising: ['ads.google.update_campaign_budget', 'ads.google.set_campaign_status', 'ads.meta.update_campaign_budget', 'ads.meta.set_campaign_status', 'ads.meta.create_campaign', 'ads.google.create_campaign'],
  messaging: ['email.send', 'sms.send', 'whatsapp.send'],
  pricing_promotions: ['commerce.shopify.create_discount'],
  store_listing: ['store.app_store.update_localization'],
  data_export: ['data.export_customer_data'],
} as const satisfies Record<string, readonly ActionTypeName[]>;

export type JurisdictionDomain = keyof typeof JURISDICTION_DOMAINS;
export const JURISDICTION_DOMAIN_KEYS = Object.keys(JURISDICTION_DOMAINS) as JurisdictionDomain[];

const domainByType = new Map<string, JurisdictionDomain>(JURISDICTION_DOMAIN_KEYS.flatMap((d) => JURISDICTION_DOMAINS[d].map((t) => [t, d] as const)));

/** The legal review domain covering an action type, or null when no pack can approve it. */
export function jurisdictionDomainOf(actionType: string): JurisdictionDomain | null {
  return domainByType.get(actionType) ?? null;
}
