import { randomBytes } from 'node:crypto';
import { CONSENT_PURPOSES, CONSENT_STATUSES, LAWFUL_BASES, type SUPPRESSION_CHANNELS } from '@futuregrow/contracts';
import {
  appInstalls,
  consentEvents,
  consentState,
  conversationMessages,
  conversations,
  customerEvents,
  customerProfiles,
  type DbOrTx,
  dsarRequests,
  evidenceRecords,
  identityIdentifiers,
  identityMerges,
  ingestionKeys,
  journeyEnrollments,
  propensityScores,
  segmentMembers,
  sequential,
  suppressions,
  type Tx,
  withTenant,
} from '@futuregrow/db';
import { conflict, forbidden, identifierHash, invalid, notFound, sha256Hex } from '@futuregrow/observability';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { ADMIN_ROLES, audit, record, requireRole } from '../../util.js';

export const MATCH_POLICY_VERSION = 'identity-match-v1';

/**
 * Deterministic identity resolution (no fingerprinting, no probabilistic merges). Profiles are
 * merged only when they share an identifier whose kind is trusted for merging. Every merge is
 * recorded with the rule that justified it (M02 AC: explainable merges).
 */
const MERGE_KINDS = new Set(['user_id', 'email', 'shopify_customer_id']);
const IDENTIFIER_KINDS = ['email', 'phone', 'user_id', 'device_id', 'anonymous_id', 'shopify_customer_id', 'app_install_id'] as const;
type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/** Property keys that carry direct identifiers; stripped from stored event properties. */
const PII_PROPERTY_KEYS = /^(e-?mail|phone|tel|first_?name|last_?name|full_?name|name|address|street|zip|postal_?code|ssn|dob|birth_?date|ip|ip_address)$/i;

/* ------------------------------------------------------------------ */
/* Ingestion keys                                                      */
/* ------------------------------------------------------------------ */

export async function createIngestionKey(tx: Tx, tenantId: string, actor: Actor, input: { kind: 'server' | 'browser'; allowedOrigins: string[] }) {
  requireRole(actor, ADMIN_ROLES, 'creating ingestion keys');
  const secret = `fgk_${input.kind === 'server' ? 'sk' : 'pk'}_${randomBytes(24).toString('base64url')}`;
  const [row] = await tx
    .insert(ingestionKeys)
    .values({ tenantId, kind: input.kind, keyPrefix: secret.slice(0, 12), keyHash: sha256Hex(secret), allowedOrigins: input.allowedOrigins, createdBy: actorRef(actor) })
    .returning();
  await audit(tx, tenantId, actor, 'customer.ingestion_key.created', { type: 'ingestion_key', id: row!.id }, { kind: input.kind, origins: input.allowedOrigins });
  // The secret is shown exactly once.
  return { id: row!.id, kind: row!.kind, key: secret, allowedOrigins: row!.allowedOrigins };
}

export async function revokeIngestionKey(tx: Tx, tenantId: string, actor: Actor, id: string) {
  requireRole(actor, ADMIN_ROLES, 'revoking ingestion keys');
  const [row] = await tx.update(ingestionKeys).set({ status: 'revoked', revokedAt: new Date() }).where(eq(ingestionKeys.id, id)).returning();
  if (!row) throw notFound('ingestion key');
  await audit(tx, tenantId, actor, 'customer.ingestion_key.revoked', { type: 'ingestion_key', id }, {});
}

/* ------------------------------------------------------------------ */
/* Event ingestion                                                     */
/* ------------------------------------------------------------------ */

export const IngestEventSchema = z.object({
  messageId: z.string().min(8).max(200),
  event: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_.:\- ]+$/),
  timestamp: z.string().datetime({ offset: true }),
  anonymousId: z.string().min(1).max(200).optional(),
  userId: z.string().min(1).max(200).optional(),
  email: z.string().email().max(320).optional(),
  phone: z.string().min(5).max(40).optional(),
  deviceId: z.string().min(1).max(200).optional(),
  properties: z.record(z.string(), z.unknown()).default({}),
  context: z
    .object({
      locale: z.string().max(35).optional(),
      country: z.string().length(2).optional(),
      timezone: z.string().max(64).optional(),
      page: z.object({ url: z.string().max(2000).optional(), referrer: z.string().max(2000).optional() }).optional(),
      campaign: z.record(z.string(), z.string().max(500)).optional(),
      consent: z.object({ analytics: z.boolean().nullable().optional(), marketing: z.boolean().nullable().optional() }).optional(),
    })
    .default({}),
  revenue: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
});
export type IngestEvent = z.infer<typeof IngestEventSchema>;

const CONTRACT_EVENTS = new Set(['order_completed', 'purchase', 'refund', 'subscription_started', 'subscription_cancelled', 'signup', 'account_deleted']);

function scrubProperties(props: Record<string, unknown>): { clean: Record<string, unknown>; removed: string[] } {
  const clean: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    if (PII_PROPERTY_KEYS.test(k)) removed.push(k);
    else if (typeof v === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) removed.push(k);
    else clean[k] = v;
  }
  return { clean, removed };
}

interface ResolvedIdentity {
  profileId: string;
  merged: string[];
}

async function resolveIdentity(tx: Tx, deps: CoreDeps, tenantId: string, ids: { kind: IdentifierKind; value: string; verified: boolean }[], hints: { email?: string; phone?: string; country?: string; locale?: string; timezone?: string }): Promise<ResolvedIdentity> {
  const hashed = ids.map((i) => ({ ...i, hash: identifierHash(deps.config.identifierPepper, i.kind, i.value) }));
  const existing = hashed.length
    ? await tx
        .select()
        .from(identityIdentifiers)
        .where(
          sql`(${identityIdentifiers.kind}, ${identityIdentifiers.valueHash}) in (${sql.join(
            hashed.map((h) => sql`(${h.kind}, ${h.hash})`),
            sql`, `,
          )})`,
        )
    : [];

  // Follow merge chains to survivors.
  const profileIds = [...new Set(existing.map((e) => e.profileId))];
  const profiles = profileIds.length ? await tx.select().from(customerProfiles).where(inArray(customerProfiles.id, profileIds)) : [];
  const survivorOf = (id: string) => profiles.find((p) => p.id === id)?.mergedIntoId ?? id;
  const candidates = [...new Set(existing.map((e) => survivorOf(e.profileId)))];

  let profileId: string;
  const merged: string[] = [];
  if (candidates.length === 0) {
    const [p] = await tx
      .insert(customerProfiles)
      .values({ tenantId, email: hints.email ?? null, phone: hints.phone ?? null, country: hints.country ?? null, locale: hints.locale ?? null, timezone: hints.timezone ?? null })
      .returning();
    profileId = p!.id;
  } else {
    // Oldest profile survives; others merge only through a trusted identifier.
    const ordered = profiles.filter((p) => candidates.includes(p.id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    profileId = ordered[0]?.id ?? candidates[0]!;
    for (const other of candidates.filter((c) => c !== profileId)) {
      const bridge = hashed.find((h) => MERGE_KINDS.has(h.kind) && (h.kind !== 'email' || h.verified) && existing.some((e) => e.kind === h.kind && e.valueHash === h.hash && survivorOf(e.profileId) === other));
      const anonBridge = hashed.find((h) => h.kind === 'anonymous_id' && existing.some((e) => e.kind === h.kind && e.valueHash === h.hash && survivorOf(e.profileId) === other));
      const knownSide = hashed.some((h) => MERGE_KINDS.has(h.kind));
      const rule = bridge ? `shared_${bridge.kind}` : anonBridge && knownSide ? 'anonymous_to_known' : null;
      if (!rule) continue; // not mergeable under policy; keep separate profiles
      const otherProfile = profiles.find((p) => p.id === other);
      if (otherProfile?.deletedAt) continue;
      await tx.update(identityIdentifiers).set({ profileId }).where(eq(identityIdentifiers.profileId, other));
      await tx.update(customerEvents).set({ profileId }).where(eq(customerEvents.profileId, other));
      await tx.update(customerProfiles).set({ mergedIntoId: profileId, updatedAt: new Date() }).where(eq(customerProfiles.id, other));
      await tx.insert(identityMerges).values({
        tenantId,
        survivorProfileId: profileId,
        mergedProfileId: other,
        matchRule: rule,
        matchPolicyVersion: MATCH_POLICY_VERSION,
        matchedIdentifierKind: (bridge ?? anonBridge)!.kind,
        confidence: 1,
      });
      merged.push(other);
    }
    const updates: Partial<typeof customerProfiles.$inferInsert> = { updatedAt: new Date() };
    const survivor = profiles.find((p) => p.id === profileId);
    if (hints.email && !survivor?.email) updates.email = hints.email;
    if (hints.phone && !survivor?.phone) updates.phone = hints.phone;
    if (hints.country && !survivor?.country) updates.country = hints.country;
    if (hints.timezone && !survivor?.timezone) updates.timezone = hints.timezone;
    await tx.update(customerProfiles).set(updates).where(eq(customerProfiles.id, profileId));
  }
  for (const h of hashed) {
    await tx.insert(identityIdentifiers).values({ tenantId, profileId, kind: h.kind, valueHash: h.hash, verified: h.verified }).onConflictDoNothing();
  }
  return { profileId, merged };
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
  dropped: { messageId: string; reason: string }[];
  profileIds: string[];
}

/**
 * Ingest first-party events. Events explicitly flagged `consent.analytics = false` are not stored
 * unless they are contract events (orders/refunds/subscriptions), which are kept minimised.
 */
export async function ingestEvents(deps: CoreDeps, tenantId: string, source: string, raw: unknown[], opts: { verifiedEmail?: boolean } = {}): Promise<IngestResult> {
  if (raw.length > 500) throw invalid('at most 500 events per batch');
  const actor = systemActor(`ingest:${source}`);
  const result: IngestResult = { accepted: 0, duplicates: 0, dropped: [], profileIds: [] };
  await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    for (const r of raw) {
      const parsed = IngestEventSchema.safeParse(r);
      if (!parsed.success) {
        result.dropped.push({ messageId: String((r as { messageId?: unknown })?.messageId ?? 'unknown'), reason: 'invalid event' });
        continue;
      }
      const e = parsed.data;
      const analyticsConsent = e.context.consent?.analytics;
      const contract = CONTRACT_EVENTS.has(e.event);
      if (analyticsConsent === false && !contract) {
        result.dropped.push({ messageId: e.messageId, reason: 'analytics consent denied' });
        continue;
      }
      const [dup] = await tx.select({ id: customerEvents.id }).from(customerEvents).where(eq(customerEvents.messageId, e.messageId));
      if (dup) {
        result.duplicates += 1;
        continue;
      }
      const ids: { kind: IdentifierKind; value: string; verified: boolean }[] = [];
      if (e.userId) ids.push({ kind: 'user_id', value: e.userId, verified: true });
      if (e.email) ids.push({ kind: 'email', value: e.email, verified: opts.verifiedEmail === true });
      if (e.phone) ids.push({ kind: 'phone', value: e.phone, verified: false });
      if (e.anonymousId) ids.push({ kind: 'anonymous_id', value: e.anonymousId, verified: false });
      if (e.deviceId) ids.push({ kind: 'device_id', value: e.deviceId, verified: false });
      let profileId: string | null = null;
      if (ids.length) {
        const res = await resolveIdentity(tx, deps, tenantId, ids, {
          ...(e.email ? { email: e.email } : {}),
          ...(e.phone ? { phone: e.phone } : {}),
          ...(e.context.country ? { country: e.context.country } : {}),
          ...(e.context.locale ? { locale: e.context.locale } : {}),
          ...(e.context.timezone ? { timezone: e.context.timezone } : {}),
        });
        profileId = res.profileId;
        if (res.merged.length) {
          await record(tx, tenantId, actor, 'customer.profile.merged', { type: 'customer_profile', id: profileId }, { merged: res.merged, policy: MATCH_POLICY_VERSION });
        }
      }
      const { clean, removed } = scrubProperties(analyticsConsent === false ? {} : e.properties);
      const context = analyticsConsent === false ? {} : { ...e.context, piiRemoved: removed.length ? removed : undefined };
      await tx.insert(customerEvents).values({
        tenantId,
        messageId: e.messageId,
        profileId,
        anonymousId: e.anonymousId ? identifierHash(deps.config.identifierPepper, 'anonymous_id', e.anonymousId) : null,
        eventName: e.event,
        occurredAt: new Date(e.timestamp),
        properties: clean,
        context,
        source,
        revenueMicros: e.revenue !== undefined ? Math.round(e.revenue * 1_000_000) : null,
        currency: e.currency ?? null,
      });
      result.accepted += 1;
      if (profileId && !result.profileIds.includes(profileId)) result.profileIds.push(profileId);
    }
    if (result.accepted) {
      await record(tx, tenantId, actor, 'customer.event.ingested', { type: 'ingest_batch', id: sha256Hex(JSON.stringify(raw.map((x) => (x as { messageId?: string }).messageId))).slice(0, 32) }, { accepted: result.accepted, source });
    }
  });
  return result;
}

/* ------------------------------------------------------------------ */
/* Consent & suppression                                               */
/* ------------------------------------------------------------------ */

export const ConsentInputSchema = z.object({
  profileId: z.string().uuid(),
  purpose: z.enum(CONSENT_PURPOSES),
  status: z.enum(CONSENT_STATUSES),
  lawfulBasis: z.enum(LAWFUL_BASES),
  jurisdiction: z.string().min(2).nullable().default(null),
  source: z.string().min(1).max(200),
  evidenceId: z.string().uuid().nullable().default(null),
  capturedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
});

export async function recordConsent(tx: Tx, tenantId: string, actor: Actor, raw: unknown) {
  const input = ConsentInputSchema.parse(raw);
  const [profile] = await tx.select().from(customerProfiles).where(eq(customerProfiles.id, input.profileId));
  if (!profile || profile.deletedAt) throw notFound('customer profile');
  if (input.status === 'granted' && input.lawfulBasis !== 'consent' && input.purpose.startsWith('marketing_')) {
    throw invalid('marketing purposes require consent as the lawful basis');
  }
  const capturedAt = new Date(input.capturedAt);
  const [ev] = await tx
    .insert(consentEvents)
    .values({ tenantId, ...input, capturedAt, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null })
    .returning();
  // Only a newer capture replaces the current state (late-arriving events cannot resurrect consent).
  await tx
    .insert(consentState)
    .values({ tenantId, profileId: input.profileId, purpose: input.purpose, status: input.status, lawfulBasis: input.lawfulBasis, consentEventId: ev!.id, capturedAt, expiresAt: ev!.expiresAt })
    .onConflictDoUpdate({
      target: [consentState.tenantId, consentState.profileId, consentState.purpose],
      set: { status: input.status, lawfulBasis: input.lawfulBasis, consentEventId: ev!.id, capturedAt, expiresAt: ev!.expiresAt },
      setWhere: sql`${consentState.capturedAt} <= ${capturedAt}`,
    });
  await record(tx, tenantId, actor, 'customer.consent.changed', { type: 'customer_profile', id: input.profileId }, { purpose: input.purpose, status: input.status, source: input.source });
  return ev!;
}

export async function addSuppression(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, input: { channel: (typeof SUPPRESSION_CHANNELS)[number]; identifier?: { kind: 'email' | 'phone'; value: string }; identifierHash?: string; reason: string; source: string }) {
  const hash = input.identifierHash ?? (input.identifier ? identifierHash(deps.config.identifierPepper, input.identifier.kind, input.identifier.value) : null);
  if (!hash) throw invalid('identifier or identifierHash required');
  // A harder reason (bounce, complaint, DSAR, legal, manual) upgrades an existing unsubscribe.
  await tx
    .insert(suppressions)
    .values({ tenantId, channel: input.channel, identifierHash: hash, reason: input.reason, source: input.source })
    .onConflictDoUpdate({
      target: [suppressions.tenantId, suppressions.channel, suppressions.identifierHash],
      set: { reason: input.reason, source: input.source },
      setWhere: sql`${suppressions.reason} = 'unsubscribe' and ${input.reason} <> 'unsubscribe'`,
    });
  await record(tx, tenantId, actor, 'customer.suppression.added', { type: 'suppression', id: hash.slice(0, 32) }, { channel: input.channel, reason: input.reason });
}

/** Suppression state for one address. `unsubscribe` only blocks commercial mail. */
export async function emailSuppression(tx: DbOrTx, deps: CoreDeps, email: string): Promise<{ any: boolean; commercialOnly: boolean }> {
  const hash = identifierHash(deps.config.identifierPepper, 'email', email);
  const rows = await tx
    .select({ reason: suppressions.reason })
    .from(suppressions)
    .where(and(eq(suppressions.identifierHash, hash), inArray(suppressions.channel, ['email', 'all'])));
  const hard = rows.some((r) => r.reason !== 'unsubscribe');
  return { any: rows.length > 0, commercialOnly: rows.length > 0 && !hard };
}

/* ------------------------------------------------------------------ */
/* Customer 360                                                        */
/* ------------------------------------------------------------------ */

export async function getProfile360(tx: Tx, id: string) {
  const [p] = await tx.select().from(customerProfiles).where(eq(customerProfiles.id, id));
  if (!p) throw notFound('customer profile');
  const target = p.mergedIntoId ?? p.id;
  const [ids, consents, events, merges, scores] = await sequential([
    tx.select({ kind: identityIdentifiers.kind, verified: identityIdentifiers.verified, firstSeenAt: identityIdentifiers.firstSeenAt }).from(identityIdentifiers).where(eq(identityIdentifiers.profileId, target)),
    tx.select().from(consentState).where(eq(consentState.profileId, target)),
    tx.select().from(customerEvents).where(eq(customerEvents.profileId, target)).orderBy(desc(customerEvents.occurredAt)).limit(100),
    tx.select().from(identityMerges).where(eq(identityMerges.survivorProfileId, target)),
    tx.select().from(propensityScores).where(eq(propensityScores.profileId, target)),
  ]);
  return { profile: p, identifiers: ids, consents, recentEvents: events, merges, scores };
}

export async function listProfiles(tx: Tx, limit = 100) {
  return tx
    .select({ id: customerProfiles.id, country: customerProfiles.country, locale: customerProfiles.locale, createdAt: customerProfiles.createdAt, deletedAt: customerProfiles.deletedAt })
    .from(customerProfiles)
    .where(isNull(customerProfiles.mergedIntoId))
    .orderBy(desc(customerProfiles.createdAt))
    .limit(Math.min(limit, 500));
}

/* ------------------------------------------------------------------ */
/* DSAR (access / delete / opt-out) with deletion propagation         */
/* ------------------------------------------------------------------ */

export const DsarInputSchema = z.object({
  kind: z.enum(['access', 'delete', 'correct', 'opt_out_sale_share']),
  identifier: z.object({ kind: z.enum(['email', 'phone', 'user_id']), value: z.string().min(3) }),
  jurisdiction: z.string().min(2).nullable().default(null),
  dueAt: z.string().datetime({ offset: true }).nullable().default(null),
});

const PRIVACY_ROLES = ['owner', 'privacy_officer'] as const;

export async function createDsar(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  const input = DsarInputSchema.parse(raw);
  const hash = identifierHash(deps.config.identifierPepper, input.identifier.kind, input.identifier.value);
  const matches = await tx
    .select({ profileId: identityIdentifiers.profileId })
    .from(identityIdentifiers)
    .where(and(eq(identityIdentifiers.kind, input.identifier.kind), eq(identityIdentifiers.valueHash, hash)));
  const [row] = await tx
    .insert(dsarRequests)
    .values({
      tenantId,
      kind: input.kind,
      subjectIdentifierHash: hash,
      profileIds: [...new Set(matches.map((m) => m.profileId))],
      jurisdiction: input.jurisdiction,
      // Statutory deadlines differ by jurisdiction [U]; the requester-entered due date is kept as given.
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
    })
    .returning();
  await record(tx, tenantId, actor, 'customer.dsar.received', { type: 'dsar', id: row!.id }, { kind: input.kind, matchedProfiles: row!.profileIds.length });
  return row!;
}

export async function verifyDsarIdentity(tx: Tx, tenantId: string, actor: Actor, id: string, method: string) {
  requireRole(actor, PRIVACY_ROLES, 'verifying a data subject request');
  const [row] = await tx
    .update(dsarRequests)
    .set({ status: 'verified', verifiedAt: new Date(), verificationMethod: method, handledBy: actorRef(actor) })
    .where(and(eq(dsarRequests.id, id), eq(dsarRequests.status, 'received')))
    .returning();
  if (!row) throw conflict('DSAR is not awaiting verification');
  await audit(tx, tenantId, actor, 'customer.dsar.verified', { type: 'dsar', id }, { method });
  return row;
}

/** All profile ids reachable through merges (survivors and merged-away profiles). */
async function profileClosure(tx: Tx, ids: string[]): Promise<string[]> {
  const set = new Set(ids);
  for (let i = 0; i < 5; i++) {
    const rows = await tx
      .select({ id: customerProfiles.id, mergedIntoId: customerProfiles.mergedIntoId })
      .from(customerProfiles)
      .where(
        sql`${customerProfiles.id} in (${sql.join(
          [...set].map((x) => sql`${x}::uuid`),
          sql`, `,
        )}) or ${customerProfiles.mergedIntoId} in (${sql.join(
          [...set].map((x) => sql`${x}::uuid`),
          sql`, `,
        )})`,
      );
    const before = set.size;
    for (const r of rows) {
      set.add(r.id);
      if (r.mergedIntoId) set.add(r.mergedIntoId);
    }
    if (set.size === before) break;
  }
  return [...set];
}

/**
 * Deletion propagation (FG-P0-006). Personal data is erased across modules; documented exemptions:
 * consent/withdrawal history (proof obligation), suppression hashes (to honour the opt-out),
 * pseudonymous experiment assignments (statistical integrity), immutable audit entries (no PII).
 */
export async function executeDsarDeletion(deps: CoreDeps, tenantId: string, actor: Actor, dsarId: string) {
  requireRole(actor, PRIVACY_ROLES, 'executing a deletion request');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const [d] = await tx.select().from(dsarRequests).where(eq(dsarRequests.id, dsarId)).for('update');
    if (!d) throw notFound('DSAR');
    if (d.kind !== 'delete') throw invalid('not a deletion request');
    if (d.status !== 'verified') throw forbidden('identity must be verified before deletion');
    await tx.update(dsarRequests).set({ status: 'processing' }).where(eq(dsarRequests.id, dsarId));
    const ids = d.profileIds.length ? await profileClosure(tx, d.profileIds) : [];
    const counts: Record<string, number> = {};
    const del = async (name: string, q: Promise<unknown[]>) => {
      counts[name] = (await q).length;
    };
    if (ids.length) {
      const emails = await tx.select({ email: customerProfiles.email }).from(customerProfiles).where(inArray(customerProfiles.id, ids));
      await del('customer_events', tx.delete(customerEvents).where(inArray(customerEvents.profileId, ids)).returning({ id: customerEvents.id }));
      await del('identity_identifiers', tx.delete(identityIdentifiers).where(inArray(identityIdentifiers.profileId, ids)).returning({ id: identityIdentifiers.id }));
      await del('consent_state', tx.delete(consentState).where(inArray(consentState.profileId, ids)).returning({ p: consentState.profileId }));
      await del('segment_members', tx.delete(segmentMembers).where(inArray(segmentMembers.profileId, ids)).returning({ p: segmentMembers.profileId }));
      await del('propensity_scores', tx.delete(propensityScores).where(inArray(propensityScores.profileId, ids)).returning({ p: propensityScores.profileId }));
      await del(
        'journey_enrollments',
        tx
          .update(journeyEnrollments)
          .set({ state: 'exited', exitReason: 'dsar_delete' })
          .where(and(inArray(journeyEnrollments.profileId, ids), eq(journeyEnrollments.state, 'active')))
          .returning({ id: journeyEnrollments.id }),
      );
      await del('app_installs', tx.update(appInstalls).set({ profileId: null, referrer: {} }).where(inArray(appInstalls.profileId, ids)).returning({ id: appInstalls.id }));
      const convs = await tx.select({ id: conversations.id }).from(conversations).where(inArray(conversations.profileId, ids));
      if (convs.length) {
        await del(
          'conversation_messages',
          tx
            .update(conversationMessages)
            .set({ text: '[erased: data subject request]', redactedText: '[erased]' })
            .where(
              inArray(
                conversationMessages.conversationId,
                convs.map((c) => c.id),
              ),
            )
            .returning({ id: conversationMessages.id }),
        );
        await tx
          .update(conversations)
          .set({ profileId: null, visitorTokenHash: null })
          .where(
            inArray(
              conversations.id,
              convs.map((c) => c.id),
            ),
          );
      }
      await del(
        'evidence_content',
        tx
          .update(evidenceRecords)
          .set({ content: null, status: 'expired' })
          .where(
            sql`${evidenceRecords.content} is not null and (${sql.join(
              ids.map((id) => sql`${evidenceRecords.content}::text like ${`%${id}%`}`),
              sql` or `,
            )})`,
          )
          .returning({ id: evidenceRecords.id }),
      );
      await del('customer_profiles', tx.update(customerProfiles).set({ email: null, phone: null, displayName: null, traits: {}, region: null, deletedAt: new Date(), updatedAt: new Date() }).where(inArray(customerProfiles.id, ids)).returning({ id: customerProfiles.id }));
      for (const e of emails) {
        if (e.email) {
          await tx
            .insert(suppressions)
            .values({ tenantId, channel: 'all', identifierHash: identifierHash(deps.config.identifierPepper, 'email', e.email), reason: 'dsar_delete', source: `dsar:${dsarId}` })
            .onConflictDoNothing();
        }
      }
    }
    const propagation = { profiles: ids, counts, exemptions: ['consent_events (proof of consent)', 'suppressions (honour opt-out)', 'experiment_assignments (pseudonymous)', 'audit_log (no personal data)'] };
    const [done] = await tx.update(dsarRequests).set({ status: 'completed', completedAt: new Date(), propagation }).where(eq(dsarRequests.id, dsarId)).returning();
    await record(tx, tenantId, actor, 'customer.dsar.completed', { type: 'dsar', id: dsarId }, { kind: 'delete', counts });
    return done!;
  });
}

export async function executeDsarOptOut(deps: CoreDeps, tenantId: string, actor: Actor, dsarId: string) {
  requireRole(actor, PRIVACY_ROLES, 'executing an opt-out request');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const [d] = await tx.select().from(dsarRequests).where(eq(dsarRequests.id, dsarId)).for('update');
    if (!d || d.kind !== 'opt_out_sale_share') throw invalid('not an opt-out request');
    const now = new Date().toISOString();
    for (const profileId of d.profileIds) {
      for (const purpose of ['sale_or_share', 'ads_customer_match', 'profiling'] as const) {
        await recordConsent(tx, tenantId, actor, { profileId, purpose, status: 'withdrawn', lawfulBasis: 'consent', jurisdiction: d.jurisdiction, source: `dsar:${dsarId}`, capturedAt: now });
      }
    }
    await tx
      .insert(suppressions)
      .values({ tenantId, channel: 'ads', identifierHash: d.subjectIdentifierHash, reason: 'dsar_opt_out', source: `dsar:${dsarId}` })
      .onConflictDoNothing();
    const [done] = await tx
      .update(dsarRequests)
      .set({ status: 'completed', completedAt: new Date(), propagation: { withdrawn: ['sale_or_share', 'ads_customer_match', 'profiling'] } })
      .where(eq(dsarRequests.id, dsarId))
      .returning();
    await record(tx, tenantId, actor, 'customer.dsar.completed', { type: 'dsar', id: dsarId }, { kind: 'opt_out_sale_share' });
    return done!;
  });
}

/** Build the data-subject export (used by the data.export_customer_data internal executor). */
export async function buildCustomerExport(tx: Tx, profileIds: string[]) {
  const ids = profileIds.length ? await profileClosure(tx, profileIds) : [];
  if (!ids.length) return { profiles: [], events: [], consents: [], consentHistory: [] };
  const [profiles, events, consents, history] = await sequential([
    tx.select().from(customerProfiles).where(inArray(customerProfiles.id, ids)),
    tx.select().from(customerEvents).where(inArray(customerEvents.profileId, ids)).orderBy(customerEvents.occurredAt),
    tx.select().from(consentState).where(inArray(consentState.profileId, ids)),
    tx.select().from(consentEvents).where(inArray(consentEvents.profileId, ids)).orderBy(consentEvents.capturedAt),
  ]);
  return { profiles, events, consents, consentHistory: history };
}

/** Engagement features for propensity models (computed in SQL; no raw PII). */
export async function profileFeatures(tx: Tx, since: Date) {
  const res = await tx.execute<{ profile_id: string; events_30d: number; sessions_30d: number; purchases_90d: number; revenue_90d: number; days_since_last: number; tenure_days: number }>(sql`
    select p.id as profile_id,
      count(e.*) filter (where e.occurred_at >= now() - interval '30 days')::int as events_30d,
      count(distinct date_trunc('day', e.occurred_at)) filter (where e.occurred_at >= now() - interval '30 days')::int as sessions_30d,
      count(e.*) filter (where e.event_name in ('purchase','order_completed') and e.occurred_at >= now() - interval '90 days')::int as purchases_90d,
      coalesce(sum(e.revenue_micros) filter (where e.occurred_at >= now() - interval '90 days'), 0)::float8 / 1e6 as revenue_90d,
      coalesce(extract(epoch from (now() - max(e.occurred_at))) / 86400, 9999)::float8 as days_since_last,
      extract(epoch from (now() - p.created_at)) / 86400 as tenure_days
    from customer_profiles p
    left join customer_events e on e.profile_id = p.id and e.occurred_at >= ${since}
    where p.deleted_at is null and p.merged_into_id is null
    group by p.id`);
  return res.rows;
}
