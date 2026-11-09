import { boolean, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, dbl, json, pk, tenantId, ts } from './_common.js';
import { brands } from './brands.js';
import { competitors } from './intelligence.js';

export const competitorDiscoverySettings = pgTable(
  'competitor_discovery_settings',
  {
    id: pk(),
    tenantId: tenantId(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    enabled: boolean('enabled').notNull().default(false),
    country: text('country').notNull(),
    intervalHours: integer('interval_hours').notNull().default(168),
    lawfulBasisNote: text('lawful_basis_note').notNull(),
    approvedBy: text('approved_by').notNull(),
    approvedAt: ts('approved_at').notNull(),
    lastAttemptAt: ts('last_attempt_at'),
  },
  (t) => [uniqueIndex('competitor_discovery_brand_uq').on(t.tenantId, t.brandId)],
);

export const competitorDiscoveryRuns = pgTable('competitor_discovery_runs', {
  id: pk(),
  tenantId: tenantId(),
  brandId: uuid('brand_id')
    .notNull()
    .references(() => brands.id),
  status: text('status').notNull(),
  query: text('query').notNull(),
  provider: text('provider').notNull(),
  note: text('note'),
  resultCount: integer('result_count').notNull().default(0),
  createdAt: createdAt(),
  finishedAt: ts('finished_at'),
});

export const competitorCandidates = pgTable(
  'competitor_candidates',
  {
    id: pk(),
    tenantId: tenantId(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    identity: text('identity').notNull(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    category: text('category').notNull(),
    score: dbl('score').notNull(),
    confidence: dbl('confidence').notNull(),
    reasons: json<string[]>('reasons').notNull(),
    evidenceId: uuid('evidence_id').notNull(),
    status: text('status').notNull().default('review'),
    competitorId: uuid('competitor_id').references(() => competitors.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => competitorDiscoveryRuns.id),
    firstSeenAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull(),
  },
  (t) => [uniqueIndex('competitor_candidates_identity_uq').on(t.tenantId, t.brandId, t.identity)],
);
