import { getActionType } from '@futuregrow/contracts';
import { connections, creatorContracts, creatorPayoutProfiles, creators, type DbOrTx, fraudFlags, payoutRequests, type Tx, withTenant } from '@futuregrow/db';
import { invalid, notFound } from '@futuregrow/observability';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { audit, clipText, requireMfa, requireRole } from '../../util.js';
import { proposeAction } from '../m23-execution/gateway.js';
import { isComplianceApproved } from '../m24-governance/compliance.js';
import { creatorBalance } from './index.js';

/**
 * Creator and affiliate payouts (P2-14). A commission balance is never reported as paid: a payout
 * request records the readiness check at request time (payable balance after clawbacks and the
 * settlement window, payout destination, verified identity/KYC, tax form, no open fraud flags,
 * legal approval, a connected payout provider, payout execution enabled), and only a request
 * without blockers is proposed through M23 (finance approval with two-factor). Today execution is
 * disabled (B-015), so every request is recorded as blocked with its reasons.
 */

const FINANCE_ROLES = ['owner', 'admin', 'finance_approver'] as const;

export const PayoutProfileSchema = z
  .object({
    provider: z.literal('paypal'),
    receiver: z.string().email().max(254),
    kycStatus: z.enum(['not_started', 'pending', 'verified', 'rejected']).default('not_started'),
    kycEvidenceId: z.string().uuid().nullable().default(null),
    taxFormEvidenceId: z.string().uuid().nullable().default(null),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable()
      .default(null),
  })
  .strict();

export async function setPayoutProfile(t: Tx, tenantId: string, actor: Actor, creatorId: string, raw: unknown) {
  requireRole(actor, [...FINANCE_ROLES], 'recording payout details');
  requireMfa(actor, 'recording payout details');
  const p = PayoutProfileSchema.parse(raw);
  if (p.kycStatus === 'verified' && !p.kycEvidenceId) throw invalid('a verified identity needs the KYC evidence record');
  const [c] = await t.select().from(creators).where(eq(creators.id, creatorId));
  if (!c) throw notFound('creator');
  const [row] = await t
    .insert(creatorPayoutProfiles)
    .values({ tenantId, creatorId, ...p, updatedBy: actorRef(actor) })
    .onConflictDoUpdate({ target: [creatorPayoutProfiles.tenantId, creatorPayoutProfiles.creatorId], set: { ...p, updatedBy: actorRef(actor), updatedAt: new Date() } })
    .returning();
  // The receiver is a payment identifier: the audit records that it changed, never the value.
  await audit(t, tenantId, actor, 'creators.payout_profile.saved', { type: 'creator', id: creatorId }, { provider: p.provider, kycStatus: p.kycStatus, taxForm: Boolean(p.taxFormEvidenceId), country: p.country });
  return { ...row!, receiver: `${row!.receiver.slice(0, 2)}…` };
}

export interface PayoutReadiness {
  payable: { currency: string; amountMicros: number }[];
  checks: { key: string; ok: boolean; detail: string }[];
}

export async function payoutReadiness(t: DbOrTx, creatorId: string, now: Date): Promise<PayoutReadiness> {
  const [c] = await t.select().from(creators).where(eq(creators.id, creatorId));
  if (!c) throw notFound('creator');
  const balance = await creatorBalance(t, creatorId, now);
  const payable = balance.filter((b) => b.payable > 0).map((b) => ({ currency: b.currency, amountMicros: b.payable }));
  const [profile] = await t.select().from(creatorPayoutProfiles).where(eq(creatorPayoutProfiles.creatorId, creatorId));
  const openFlags = await t
    .select({ id: fraudFlags.id })
    .from(fraudFlags)
    .where(and(eq(fraudFlags.creatorId, creatorId), eq(fraudFlags.status, 'open')));
  const contracts = await t.select({ id: creatorContracts.id }).from(creatorContracts).where(eq(creatorContracts.creatorId, creatorId));
  const [provider] = await t
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.provider, 'paypal'), eq(connections.status, 'active')))
    .limit(1);
  const action = getActionType('creator.payout');
  // P2-15: counsel's approved, unexpired review of creator payouts.
  const legal = await isComplianceApproved(t, 'creator_payouts', now);
  const checks = [
    { key: 'payable_balance', ok: payable.length > 0, detail: payable.length ? payable.map((p) => `${p.amountMicros / 1e6} ${p.currency}`).join(', ') : 'nothing payable yet (refund window or clawbacks)' },
    { key: 'creator_active', ok: c.status === 'active', detail: `creator is ${c.status}` },
    { key: 'contract', ok: contracts.length > 0, detail: contracts.length ? 'contract with disclosure terms on file' : 'no creator contract' },
    { key: 'destination', ok: Boolean(profile?.receiver), detail: profile ? `${profile.provider} receiver recorded` : 'no payout destination recorded' },
    { key: 'identity', ok: profile?.kycStatus === 'verified' && Boolean(profile.kycEvidenceId), detail: `KYC ${profile?.kycStatus ?? 'not_started'}` },
    { key: 'tax_form', ok: Boolean(profile?.taxFormEvidenceId), detail: profile?.taxFormEvidenceId ? 'tax form evidence recorded' : 'no tax form evidence' },
    { key: 'fraud_review', ok: openFlags.length === 0, detail: openFlags.length ? `${openFlags.length} open fraud flag(s)` : 'no open fraud flags' },
    { key: 'legal_approval', ok: legal, detail: legal ? 'creator payouts approved by counsel (compliance registry)' : 'no counsel-approved record for creator payouts (P2-15)' },
    { key: 'provider', ok: Boolean(provider), detail: provider ? 'payout provider connected' : 'no payout provider connected (PayPal Payouts)' },
    { key: 'execution_enabled', ok: Boolean(action?.supported), detail: action?.supported ? 'payout execution enabled' : `payout execution disabled (${action?.blockerRef ?? 'B-015'})` },
  ];
  return { payable, checks };
}

/**
 * Requests a payout. With any failed check the request is stored as blocked (nothing proposed,
 * nothing paid). Otherwise the payout is proposed through M23, bound to this request's id as the
 * provider's idempotency key, and only the provider's read-back can mark it paid.
 */
export async function requestPayout(deps: CoreDeps, tenantId: string, actor: Actor, creatorId: string) {
  requireRole(actor, [...FINANCE_ROLES], 'requesting payouts');
  const now = deps.clock.now();
  const { readiness, request, profile, providerId } = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const readiness = await payoutReadiness(t, creatorId, now);
    const blockers = readiness.checks.filter((c) => !c.ok).map((c) => `${c.key}: ${c.detail}`);
    const [request] = await t
      .insert(payoutRequests)
      .values({ tenantId, creatorId, status: blockers.length ? 'blocked' : 'proposed', amounts: readiness.payable, readiness: { checks: readiness.checks, checkedAt: now.toISOString() }, blockers, requestedBy: actorRef(actor) })
      .returning();
    await audit(t, tenantId, actor, blockers.length ? 'creators.payout.blocked' : 'creators.payout.requested', { type: 'payout_request', id: request!.id }, { creatorId, blockers: blockers.map((b) => clipText(b, 120)), amounts: readiness.payable });
    const [profile] = await t.select().from(creatorPayoutProfiles).where(eq(creatorPayoutProfiles.creatorId, creatorId));
    const [provider] = await t
      .select({ id: connections.id })
      .from(connections)
      .where(and(eq(connections.provider, 'paypal'), eq(connections.status, 'active')))
      .limit(1);
    return { readiness, request: request!, profile, providerId: provider?.id ?? null };
  });
  if (request.status === 'blocked') return { request, action: null };
  const total = readiness.payable[0]!;
  const action = await proposeAction(deps, tenantId, actor, {
    actionType: 'creator.payout',
    connectionId: providerId,
    target: { creatorId, payoutRequestId: request.id },
    params: { payoutRequestId: request.id, creatorId, items: readiness.payable.map((p, i) => ({ itemId: `${request.id.slice(0, 18)}-${i}`, receiver: profile!.receiver, amountMicros: p.amountMicros, currency: p.currency, note: 'Commission payout' })) },
    risk: { spendDeltaMicros: total.amountMicros, currency: total.currency, audienceSize: null, geographies: profile?.country ? [profile.country] : [], usesSensitiveAttributes: false, involvesChildren: false, syntheticPersonaId: null, materialConnection: true, regulatedClaim: false },
    idempotencyKey: `payout:${request.id}`,
  });
  const updated = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const [u] = await t
      .update(payoutRequests)
      .set({ status: action.status === 'DENIED' ? 'denied' : 'proposed', actionId: action.id, updatedAt: now })
      .where(eq(payoutRequests.id, request.id))
      .returning();
    return u!;
  });
  return { request: updated, action };
}

export async function recordPayoutDispute(t: Tx, tenantId: string, actor: Actor, requestId: string, reason: string) {
  requireRole(actor, [...FINANCE_ROLES], 'recording a payout dispute');
  if (reason.trim().length < 5) throw invalid('describe the dispute');
  const [r] = await t.select().from(payoutRequests).where(eq(payoutRequests.id, requestId));
  if (!r) throw notFound('payout request');
  const [u] = await t
    .update(payoutRequests)
    .set({ status: 'disputed', dispute: { reason: clipText(reason, 1000), previousStatus: r.status, recordedBy: actorRef(actor), at: new Date().toISOString() }, updatedAt: new Date() })
    .where(eq(payoutRequests.id, requestId))
    .returning();
  await audit(t, tenantId, actor, 'creators.payout.disputed', { type: 'payout_request', id: requestId }, { previousStatus: r.status });
  return u!;
}

export async function listPayoutRequests(t: DbOrTx, creatorId?: string) {
  return t
    .select()
    .from(payoutRequests)
    .where(creatorId ? eq(payoutRequests.creatorId, creatorId) : undefined)
    .orderBy(desc(payoutRequests.createdAt))
    .limit(200);
}
