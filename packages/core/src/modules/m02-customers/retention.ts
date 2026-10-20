import { competitorSnapshots, conversationMessages, conversations, customerEvents, type DbOrTx, messages, referralClicks, retentionPolicies, type Tx, webhookInbox, withSystem, withTenant } from '@futuregrow/db';
import { invalid } from '@futuregrow/observability';
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, requireMfa, requireRole } from '../../util.js';

/**
 * Data retention (product plan P0: retention propagation). Durations are tenant decisions `[U]`:
 * without a policy row nothing is deleted. Floors below are integrity constraints, not defaults:
 * frequency caps look back 7 days, so lifecycle messages are kept at least 8; the newest
 * competitor snapshot per source is always kept for diffing. Legal hold suspends a class.
 */
export const DATA_CLASSES = ['customer_events', 'conversations', 'evidence_snapshots', 'webhook_payloads', 'messages', 'referral_clicks'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const MIN_RETAIN_DAYS: Record<DataClass, number> = {
  customer_events: 1,
  conversations: 1,
  evidence_snapshots: 1,
  webhook_payloads: 1,
  messages: 8,
  referral_clicks: 1,
};

export const RetentionInputSchema = z.object({
  dataClass: z.enum(DATA_CLASSES),
  retainDays: z.number().int().positive().max(3650).nullable(),
  legalHold: z.boolean().default(false),
});

export async function setRetentionPolicy(tx: Tx, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'privacy_officer'], 'setting retention policies');
  requireMfa(actor, 'setting retention policies');
  const p = RetentionInputSchema.parse(raw);
  if (p.retainDays !== null && p.retainDays < MIN_RETAIN_DAYS[p.dataClass]) throw invalid(`${p.dataClass} must be retained at least ${MIN_RETAIN_DAYS[p.dataClass]} days`);
  const [row] = await tx
    .insert(retentionPolicies)
    .values({ tenantId, ...p, updatedBy: actorRef(actor) })
    .onConflictDoUpdate({ target: [retentionPolicies.tenantId, retentionPolicies.dataClass], set: { retainDays: p.retainDays, legalHold: p.legalHold, updatedBy: actorRef(actor), updatedAt: new Date() } })
    .returning();
  await audit(tx, tenantId, actor, 'customer.retention.policy_set', { type: 'retention_policy', id: p.dataClass }, p);
  return row!;
}

export async function listRetentionPolicies(tx: DbOrTx) {
  return tx.select().from(retentionPolicies).orderBy(retentionPolicies.dataClass);
}

/** Apply every configured policy for one tenant; returns affected row counts per class. */
export async function applyRetention(deps: CoreDeps, tenantId: string): Promise<Record<string, number | string>> {
  const actor = systemActor('retention');
  const now = deps.clock.now();
  const policies = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (tx) => listRetentionPolicies(tx));
  const out: Record<string, number | string> = {};
  for (const p of policies) {
    const cls = p.dataClass as DataClass;
    if (p.legalHold) {
      out[cls] = 'legal_hold';
      continue;
    }
    if (p.retainDays === null) continue;
    const cutoff = new Date(now.getTime() - Math.max(p.retainDays, MIN_RETAIN_DAYS[cls]) * 86_400_000);
    if (cls === 'webhook_payloads') {
      // Platform table keyed by resolved tenant (no RLS): owner path, scoped explicitly.
      const r = await withSystem(deps.db, 'system:retention', (tx) =>
        tx
          .update(webhookInbox)
          .set({ payload: { erased: 'retention' }, headers: {} })
          .where(and(eq(webhookInbox.resolvedTenantId, tenantId), lt(webhookInbox.receivedAt, cutoff), inArray(webhookInbox.status, ['processed', 'ignored', 'failed', 'rejected_signature']), sql`${webhookInbox.payload}::text <> '{"erased": "retention"}'`))
          .returning({ id: webhookInbox.id }),
      );
      out[cls] = r.length;
      continue;
    }
    out[cls] = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
      switch (cls) {
        case 'customer_events':
          return (await tx.delete(customerEvents).where(lt(customerEvents.occurredAt, cutoff)).returning({ id: customerEvents.id })).length;
        case 'messages':
          return (await tx.delete(messages).where(lt(messages.createdAt, cutoff)).returning({ id: messages.id })).length;
        case 'referral_clicks':
          return (await tx.delete(referralClicks).where(lt(referralClicks.clickedAt, cutoff)).returning({ id: referralClicks.id })).length;
        case 'conversations': {
          // Closed conversations only: text is erased, metadata (counts, tickets, leads) stays.
          const old = await tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(and(eq(conversations.status, 'closed'), lt(conversations.lastMessageAt, cutoff), isNotNull(conversations.visitorTokenHash)));
          if (!old.length) return 0;
          const ids = old.map((c) => c.id);
          await tx.update(conversationMessages).set({ text: '[erased: retention]', redactedText: '[erased]' }).where(inArray(conversationMessages.conversationId, ids));
          await tx.update(conversations).set({ visitorTokenHash: null, profileId: null }).where(inArray(conversations.id, ids));
          return ids.length;
        }
        case 'evidence_snapshots': {
          const old = await tx
            .select({ id: competitorSnapshots.id, objectKey: competitorSnapshots.objectKey })
            .from(competitorSnapshots)
            .where(and(lt(competitorSnapshots.fetchedAt, cutoff), sql`${competitorSnapshots.objectKey} <> ''`, sql`${competitorSnapshots.id} <> (select s2.id from competitor_snapshots s2 where s2.source_id = ${competitorSnapshots.sourceId} order by s2.fetched_at desc limit 1)`));
          for (const s of old) await deps.store.delete(s.objectKey);
          if (old.length)
            await tx
              .update(competitorSnapshots)
              .set({ objectKey: '', textExcerpt: '' })
              .where(
                inArray(
                  competitorSnapshots.id,
                  old.map((s) => s.id),
                ),
              );
          return old.length;
        }
      }
    });
  }
  if (Object.keys(out).length) await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (tx) => audit(tx, tenantId, actor, 'customer.retention.applied', { type: 'tenant', id: tenantId }, out));
  return out;
}
