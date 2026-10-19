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
    description: 'Publish a text/link post to an authorized Facebook Page.',
    affectsSpend: false,
    publicFacing: true,
    contactsPeople: false,
    verification: 'read_after_write',
    rollback: 'supported',
    supported: true,
    paramsSchema: z.object({
      pageId: z.string().min(1),
      message: z.string().min(1).max(63206),
      link: z.string().url().optional(),
      postId: z.string().uuid(),
      assetIds: z.array(z.string().uuid()).max(0).default([]),
      claimIds: z.array(z.string().uuid()).default([]),
      disclosure,
    }),
  },
  {
    type: 'social.instagram.publish_media',
    provider: 'meta',
    capability: 'instagram_content_publish',
    category: 'PUBLIC_PUBLISHING',
    description: 'Publish an image or reel to an authorized Instagram professional account.',
    affectsSpend: false,
    publicFacing: true,
    contactsPeople: false,
    verification: 'status_poll',
    rollback: 'manual',
    supported: true,
    paramsSchema: z.object({
      igUserId: z.string().min(1),
      mediaType: z.enum(['IMAGE', 'REELS']),
      mediaUrl: z.string().url(),
      caption: z.string().max(2200),
      postId: z.string().uuid(),
      assetIds: z.array(z.string().uuid()).min(1),
      claimIds: z.array(z.string().uuid()).default([]),
      disclosure,
    }),
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
    provider: 'internal',
    capability: 'creator_payout',
    category: 'PAYOUT',
    description: 'Pay a creator/affiliate. Payment provider unspecified [U].',
    affectsSpend: true,
    publicFacing: false,
    contactsPeople: false,
    verification: 'reconciliation',
    rollback: 'manual',
    supported: false,
    blockerRef: 'B-015',
    paramsSchema: z.object({}).passthrough(),
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
