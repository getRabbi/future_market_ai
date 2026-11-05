import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, json, oneOf, pk, rawCheck, tenantId, ts, updatedAt, uuidArray } from './_common.js';
import { socialPosts } from './growth.js';
import { connections } from './platform.js';
import { contentPlanItems, studioPrograms } from './studio.js';

/* ------------------------------------------------------------------ */
/* Brands (multi-brand creative growth studio)                         */
/* ------------------------------------------------------------------ */

export const BRAND_STATUSES = ['active', 'paused', 'archived'] as const;
export const BRAND_APP_PLATFORMS = ['android', 'ios'] as const;

/**
 * A brand or product line an organization markets. The profile (voice, visual identity, audience,
 * objectives, destinations, limits) is validated by the core brand schema; product facts and their
 * approved claims stay in the knowledge graph and are referenced, never copied.
 */
export const brands = pgTable(
  'brands',
  {
    id: pk(),
    tenantId: tenantId(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    profile: json<Record<string, unknown>>('profile').notNull().default({}),
    /** kg_entities product facts describing this brand's products; claims attach to those facts. */
    productEntityIds: uuidArray('product_entity_ids').notNull().default(sql`'{}'::uuid[]`),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('brands_slug_uq').on(t.tenantId, t.slug), oneOf('brands_status_chk', t.status, BRAND_STATUSES), rawCheck('brands_slug_chk', sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,47}$'`)],
);

/** A connected channel account (Page, profile, channel) belongs to exactly one brand. */
export const brandChannels = pgTable(
  'brand_channels',
  {
    id: pk(),
    tenantId: tenantId(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('brand_channels_conn_uq').on(t.tenantId, t.connectionId), index('brand_channels_brand_idx').on(t.tenantId, t.brandId)],
);

/** A store application (Play package name / App Store id) belongs to exactly one brand. */
export const brandApps = pgTable(
  'brand_apps',
  {
    id: pk(),
    tenantId: tenantId(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    appId: text('app_id').notNull(),
    listingUrl: text('listing_url').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('brand_apps_app_uq').on(t.tenantId, t.platform, t.appId), index('brand_apps_brand_idx').on(t.tenantId, t.brandId), oneOf('brand_apps_platform_chk', t.platform, BRAND_APP_PLATFORMS)],
);

/**
 * The identity behind a tagged store link: which brand, program, calendar item, channel account and
 * post produced (campaign, content) for an application. Installs are mapped to content through this
 * registry, never by guessing from free-text UTM labels.
 */
export const campaignLinks = pgTable(
  'campaign_links',
  {
    id: pk(),
    tenantId: tenantId(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    programId: uuid('program_id').references(() => studioPrograms.id, { onDelete: 'set null' }),
    planItemId: uuid('plan_item_id').references(() => contentPlanItems.id, { onDelete: 'set null' }),
    postId: uuid('post_id').references(() => socialPosts.id, { onDelete: 'set null' }),
    connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
    channelPlatform: text('channel_platform').notNull(),
    appPlatform: text('app_platform').notNull(),
    appId: text('app_id').notNull(),
    campaign: text('campaign').notNull(),
    content: text('content').notNull(),
    url: text('url').notNull(),
    /**
     * What a store report can tell apart: `content` = (campaign, content) as the device referrer
     * carries it; `campaign` = utm_campaign alone identifies this post (D-045), so Play's
     * store-performance report (which has no utm_content) can still name the post.
     */
    reportScope: text('report_scope').notNull().default('content'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    retiredAt: ts('retired_at'),
  },
  (t) => [
    uniqueIndex('campaign_links_identity_uq').on(t.tenantId, t.appPlatform, t.appId, t.campaign, t.content),
    uniqueIndex('campaign_links_campaign_scope_uq').on(t.tenantId, t.appPlatform, t.appId, t.campaign).where(sql`${t.reportScope} = 'campaign'`),
    oneOf('campaign_links_report_scope_chk', t.reportScope, ['content', 'campaign']),
    index('campaign_links_brand_idx').on(t.tenantId, t.brandId, t.createdAt),
    oneOf('campaign_links_app_platform_chk', t.appPlatform, BRAND_APP_PLATFORMS),
  ],
);
