import { sql } from 'drizzle-orm';
import { date, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, dbl, json, oneOf, pk, rawCheck, tenantId, ts, updatedAt } from './_common.js';
import { growthGoals } from './autopilot.js';
import { brands } from './brands.js';
import { assets, socialPosts } from './growth.js';
import { connections } from './platform.js';

/* ------------------------------------------------------------------ */
/* Creative studio (D-040)                                             */
/* ------------------------------------------------------------------ */

export const STUDIO_PROGRAM_STATUSES = ['active', 'paused'] as const;
export const PLAN_ITEM_STATUSES = ['planned', 'drafted', 'submitted', 'published', 'skipped', 'failed'] as const;
export const COMMUNITY_PERMISSIONS = ['unknown', 'members_may_post', 'admin_approval', 'admin_only', 'owned'] as const;
export const COMMUNITY_STATUSES = ['candidate', 'member', 'approved', 'declined', 'archived'] as const;
export const SHARE_STATUSES = ['prepared', 'shared', 'declined', 'expired'] as const;

/** A Facebook Page that publishes from a curriculum pack (one program per connection). */
export const studioPrograms = pgTable(
  'studio_programs',
  {
    id: pk(),
    tenantId: tenantId(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    pack: text('pack').notNull(),
    /** The brand this program publishes for (D-041); null for programs created before brands existed. */
    brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('active'),
    /** appUrl (verified store listing), campaign, appCtaPerWeek, linkPerWeek. */
    settings: json<Record<string, unknown>>('settings').notNull().default({}),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('studio_programs_conn_uq').on(t.tenantId, t.connectionId), oneOf('studio_programs_status_chk', t.status, STUDIO_PROGRAM_STATUSES)],
);

/** One planned post: what it teaches, for whom, why, how it looks, and what it achieved. */
export const contentPlanItems = pgTable(
  'content_plan_items',
  {
    id: pk(),
    tenantId: tenantId(),
    programId: uuid('program_id')
      .notNull()
      .references(() => studioPrograms.id, { onDelete: 'cascade' }),
    goalId: uuid('goal_id').references(() => growthGoals.id, { onDelete: 'set null' }),
    day: date('day', { mode: 'string' }).notNull(),
    kind: text('kind').notNull(),
    unitId: text('unit_id'),
    packVersion: text('pack_version').notNull(),
    objective: text('objective').notNull(),
    segment: text('segment').notNull(),
    template: text('template').notNull(),
    palette: text('palette').notNull(),
    variant: integer('variant').notNull().default(0),
    hookId: text('hook_id'),
    promptId: text('prompt_id'),
    ctaFeature: text('cta_feature'),
    rationale: text('rationale').notNull(),
    status: text('status').notNull().default('planned'),
    statusReason: text('status_reason'),
    postId: uuid('post_id').references(() => socialPosts.id, { onDelete: 'set null' }),
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    dhash: text('dhash'),
    publishedAt: ts('published_at'),
    /** Observed counters of the published post (reactions, comments, shares, observedAt); never estimated. */
    metrics: json<Record<string, unknown>>('metrics').notNull().default({}),
    engagement: dbl('engagement'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('content_plan_day_uq').on(t.programId, t.day),
    index('content_plan_status_idx').on(t.tenantId, t.status, t.day),
    oneOf('content_plan_status_chk', t.status, PLAN_ITEM_STATUSES),
    oneOf('content_plan_objective_chk', t.objective, ['EDUCATE', 'ENGAGE', 'DISCOVER', 'VISIT_APP', 'INSTALL_APP', 'RETAIN']),
    rawCheck('content_plan_variant_chk', sql`${t.variant} in (0, 1)`),
  ],
);

/**
 * Community growth workspace: Facebook groups the owner may share lessons in. Nothing here posts
 * to a group; the owner shares by hand where the group's rules allow it and confirms the share.
 */
export const communityGroups = pgTable(
  'community_groups',
  {
    id: pk(),
    tenantId: tenantId(),
    url: text('url').notNull(),
    name: text('name').notNull(),
    audience: text('audience').notNull().default(''),
    rules: text('rules').notNull().default(''),
    permission: text('permission').notNull().default('unknown'),
    status: text('status').notNull().default('candidate'),
    /** Keyword relevance to the program's topic, 0..1 (computed, explained in relevanceNotes). */
    relevance: dbl('relevance').notNull().default(0),
    relevanceNotes: text('relevance_notes').notNull().default(''),
    memberCount: integer('member_count'),
    notes: text('notes').notNull().default(''),
    lastSharedAt: ts('last_shared_at'),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('community_groups_url_uq').on(t.tenantId, t.url), oneOf('community_groups_permission_chk', t.permission, COMMUNITY_PERMISSIONS), oneOf('community_groups_status_chk', t.status, COMMUNITY_STATUSES)],
);

export const communityShares = pgTable(
  'community_shares',
  {
    id: pk(),
    tenantId: tenantId(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => communityGroups.id, { onDelete: 'cascade' }),
    planItemId: uuid('plan_item_id').references(() => contentPlanItems.id, { onDelete: 'set null' }),
    kind: text('kind').notNull().default('lesson'),
    caption: text('caption').notNull(),
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('prepared'),
    permalink: text('permalink'),
    /** What the owner observed after sharing (e.g. comments, new Page followers they attribute); self-reported. */
    outcome: json<Record<string, unknown>>('outcome').notNull().default({}),
    confirmedBy: text('confirmed_by'),
    confirmedAt: ts('confirmed_at'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('community_shares_group_idx').on(t.tenantId, t.groupId, t.createdAt), oneOf('community_shares_status_chk', t.status, SHARE_STATUSES), oneOf('community_shares_kind_chk', t.kind, ['lesson', 'permission_request'])],
);
