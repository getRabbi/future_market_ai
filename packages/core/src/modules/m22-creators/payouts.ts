import { getActionType } from '@futuregrow/contracts';
import { commissionLedger, connections, creatorContracts, creatorPayoutProfiles, creators, type DbOrTx, fraudFlags, payoutRequests, sequential, type Tx, withTenant } from '@futuregrow/db';
import { invalid, notFound } from '@futuregrow/observability';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { audit, clipText, requireMfa, requireRole } from '../../util.js';
import { proposeAction } from '../m23-execution/gateway.js';
import { registerHooks } from '../m23-execution/registry.js';
import { isComplianceApproved } from '../m24-governance/compliance.js';
import { creatorBalance, PAYABLE_AFTER_DAYS } from './index.js';

/**
 * Creator and affiliate payouts (P2-14). A commission balance is never reported as paid: a payout
 * request records the readiness check at request time (payable balance after clawbacks and the
 * settlement window, payout destination, verified identity/KYC, tax form, no open fraud flags,
 * legal approval, a connected payout provider, payout execution enabled), and only a request
 * without blockers is proposed through M23 (finance approval with two-factor). Today execution is
 * disabled (B-015), so every request is recorded as blocked with its reasons.
 */

const FINANCE_ROLES = ['owner', 'admin', 'finance_approver'] as const;
/** Who may see balances, masked payout destinations and payout history. */
export const PAYOUT_READERS = ['owner', 'admin', 'finance_approver', 'growth_operator', 'analyst'] as const;
/** A request in one of these states may still pay out: no second request until it ends. */
export const OPEN_PAYOUT_STATUSES = ['proposed', 'approved', 'sent'] as const;

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
  const open = await t
    .select({ id: payoutRequests.id })
    .from(payoutRequests)
    .where(and(eq(payoutRequests.creatorId, creatorId), inArray(payoutRequests.status, [...OPEN_PAYOUT_STATUSES])));
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
    { key: 'no_open_request', ok: open.length === 0, detail: open.length ? 'an earlier payout request is still awaiting approval or the provider; it must finish first' : 'no other payout request in progress' },
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

/* ------------------------------------------------------------------ */
/* Reconciliation (M23 hooks)                                          */
/* ------------------------------------------------------------------ */

/**
 * A payout counts as paid only when the provider's batch read-back says so (M23 VERIFIED). The
 * paid amounts are then written to the commission ledger once (unique ref per request and
 * currency), which lowers the payable balance; a failed, denied or rejected payout pays nothing.
 */
registerHooks('creator.payout', {
  async onVerified(tx, action, receipt) {
    const p = action.params as { payoutRequestId: string; creatorId: string; items: { amountMicros: number; currency: string }[] };
    const [req] = await tx.select().from(payoutRequests).where(eq(payoutRequests.id, p.payoutRequestId));
    if (!req || req.status === 'paid') return;
    const byCurrency = new Map<string, number>();
    for (const i of p.items) byCurrency.set(i.currency, (byCurrency.get(i.currency) ?? 0) + i.amountMicros);
    for (const [currency, amount] of byCurrency) {
      await tx
        .insert(commissionLedger)
        .values({ tenantId: action.tenantId, creatorId: p.creatorId, conversionId: null, kind: 'payout', amountMicros: -amount, currency, ref: `payout:${p.payoutRequestId}:${currency}` })
        .onConflictDoNothing();
    }
    await tx
      .update(payoutRequests)
      .set({ status: 'paid', providerBatchId: receipt.providerObjectId ?? null, providerStatus: 'paid', reconciledAt: new Date(), updatedAt: new Date() })
      .where(eq(payoutRequests.id, p.payoutRequestId));
  },
  async onTerminalFailure(tx, action, status, reason) {
    const p = action.params as { payoutRequestId: string };
    const next = status === 'DENIED' || status === 'REJECTED' || status === 'CANCELLED' ? 'denied' : 'failed';
    await tx
      .update(payoutRequests)
      .set({ status: next, providerStatus: clipText(`${status}: ${reason}`, 300), updatedAt: new Date() })
      .where(and(eq(payoutRequests.id, p.payoutRequestId), inArray(payoutRequests.status, [...OPEN_PAYOUT_STATUSES])));
  },
});

/* ------------------------------------------------------------------ */
/* Overview (Channels › Creator payouts)                               */
/* ------------------------------------------------------------------ */

const mask = (receiver: string) => `${receiver.slice(0, 2)}…`;

/**
 * Every creator's balance, payout destination (masked), readiness and latest request, the
 * request history with reconciliation state, and why execution is off. Batched reads; calls no
 * provider and changes nothing.
 */
export async function payoutsOverview(t: DbOrTx, actor: Actor, now: Date) {
  requireRole(actor, [...PAYOUT_READERS], 'viewing creator balances and payouts');
  const list = await t.select().from(creators).orderBy(asc(creators.name)).limit(500);
  const ids = list.map((c) => c.id);
  const cutoff = new Date(now.getTime() - PAYABLE_AFTER_DAYS * 86_400_000);
  const balances = ids.length
    ? (
        await t.execute<{ creator_id: string; currency: string; accrued: number; clawed: number; paid: number; payable: number; pending: number }>(sql`
          select l.creator_id, l.currency,
            coalesce(sum(l.amount_micros) filter (where l.kind = 'accrual'), 0)::bigint as accrued,
            coalesce(sum(l.amount_micros) filter (where l.kind = 'clawback'), 0)::bigint as clawed,
            coalesce(sum(l.amount_micros) filter (where l.kind = 'payout'), 0)::bigint as paid,
            coalesce(sum(l.amount_micros) filter (where l.kind <> 'accrual' or c.occurred_at < ${cutoff}), 0)::bigint as payable,
            coalesce(sum(l.amount_micros) filter (where l.kind = 'accrual' and (c.occurred_at is null or c.occurred_at >= ${cutoff})), 0)::bigint as pending
          from commission_ledger l left join referral_conversions c on c.id = l.conversion_id
          group by l.creator_id, l.currency`)
      ).rows
    : [];
  const [profiles, flags, contracts, requests, provider] = await sequential([
    ids.length ? t.select().from(creatorPayoutProfiles) : Promise.resolve([]),
    ids.length ? t.select({ creatorId: fraudFlags.creatorId, n: sql<number>`count(*)::int` }).from(fraudFlags).where(eq(fraudFlags.status, 'open')).groupBy(fraudFlags.creatorId) : Promise.resolve([]),
    ids.length ? t.select({ creatorId: creatorContracts.creatorId, n: sql<number>`count(*)::int` }).from(creatorContracts).groupBy(creatorContracts.creatorId) : Promise.resolve([]),
    t.select().from(payoutRequests).orderBy(desc(payoutRequests.createdAt)).limit(200),
    t.select({ id: connections.id, displayName: connections.displayName, status: connections.status }).from(connections).where(eq(connections.provider, 'paypal')).limit(5),
  ]);
  const action = getActionType('creator.payout');
  const legal = await isComplianceApproved(t, 'creator_payouts', now);
  const activeProvider = provider.find((p) => p.status === 'active') ?? null;
  const name = new Map(list.map((c) => [c.id, c.name]));
  const rows = list.map((c) => {
    const bal = balances.filter((b) => b.creator_id === c.id).map((b) => ({ currency: b.currency, accruedMicros: Number(b.accrued), clawedBackMicros: Math.abs(Number(b.clawed)), paidMicros: Math.abs(Number(b.paid)), payableMicros: Math.max(0, Number(b.payable)), inRefundWindowMicros: Number(b.pending) }));
    const prof = profiles.find((p) => p.creatorId === c.id);
    const open = requests.filter((r) => r.creatorId === c.id && (OPEN_PAYOUT_STATUSES as readonly string[]).includes(r.status));
    const flagCount = flags.find((f) => f.creatorId === c.id)?.n ?? 0;
    const checks = [
      { key: 'payable_balance', ok: bal.some((b) => b.payableMicros > 0) },
      { key: 'creator_active', ok: c.status === 'active' },
      { key: 'contract', ok: (contracts.find((x) => x.creatorId === c.id)?.n ?? 0) > 0 },
      { key: 'destination', ok: Boolean(prof?.receiver) },
      { key: 'identity', ok: prof?.kycStatus === 'verified' && Boolean(prof.kycEvidenceId) },
      { key: 'tax_form', ok: Boolean(prof?.taxFormEvidenceId) },
      { key: 'no_open_request', ok: open.length === 0 },
      { key: 'fraud_review', ok: flagCount === 0 },
      { key: 'legal_approval', ok: legal },
      { key: 'provider', ok: Boolean(activeProvider) },
      { key: 'execution_enabled', ok: Boolean(action?.supported) },
    ];
    const last = requests.find((r) => r.creatorId === c.id);
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      balance: bal,
      profile: prof ? { provider: prof.provider, receiver: mask(prof.receiver), kycStatus: prof.kycStatus, taxForm: Boolean(prof.taxFormEvidenceId), country: prof.country, updatedAt: prof.updatedAt.toISOString() } : null,
      openFraudFlags: flagCount,
      readiness: { ready: checks.every((x) => x.ok), failing: checks.filter((x) => !x.ok).map((x) => x.key) },
      lastRequest: last ? { id: last.id, status: last.status, createdAt: last.createdAt.toISOString() } : null,
    };
  });
  return {
    asOf: now.toISOString(),
    execution: {
      enabled: Boolean(action?.supported),
      blockerRef: action?.blockerRef ?? 'B-015',
      legalApproved: legal,
      provider: activeProvider,
      approval: 'Every payout is an M23 action that always needs a finance approver with two-factor; the requester can never approve it.',
    },
    creators: rows,
    requests: requests.map((r) => ({
      id: r.id,
      creatorId: r.creatorId,
      creator: name.get(r.creatorId) ?? null,
      status: r.status,
      amounts: r.amounts,
      blockers: r.blockers,
      actionId: r.actionId,
      providerBatchId: r.providerBatchId,
      providerStatus: r.providerStatus,
      reconciledAt: r.reconciledAt?.toISOString() ?? null,
      dispute: r.dispute,
      requestedBy: r.requestedBy,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
    reconciliation: {
      awaitingProvider: requests.filter((r) => r.status === 'sent' || r.status === 'approved').length,
      paid: requests.filter((r) => r.status === 'paid').length,
      unreconciledPaid: requests.filter((r) => r.status === 'paid' && !r.reconciledAt).length,
      note: 'A request is paid only after the provider’s batch read-back confirms it; the ledger records each paid request once.',
    },
    payableAfterDays: PAYABLE_AFTER_DAYS,
  };
}

/** Recent ledger entries of one creator (accruals, clawbacks, payouts, adjustments) for the reconciliation view. */
export async function creatorLedger(t: DbOrTx, actor: Actor, creatorId: string) {
  requireRole(actor, [...PAYOUT_READERS], 'viewing a creator ledger');
  const [c] = await t.select({ id: creators.id }).from(creators).where(eq(creators.id, creatorId));
  if (!c) throw notFound('creator');
  const rows = await t.select().from(commissionLedger).where(eq(commissionLedger.creatorId, creatorId)).orderBy(desc(commissionLedger.createdAt)).limit(200);
  return rows.map((r) => ({ id: r.id, kind: r.kind, amountMicros: r.amountMicros, currency: r.currency, ref: r.ref, conversionId: r.conversionId, createdAt: r.createdAt.toISOString() }));
}
