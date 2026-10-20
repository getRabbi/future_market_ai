import { randomBytes } from 'node:crypto';
import { commissionLedger, creatorContracts, creatorSubmissions, creators, type DbOrTx, evidenceRecords, fraudFlags, referralClicks, referralConversions, referralLinks, sequential, type Tx, withSystem, withTenant } from '@futuregrow/db';
import { FgError, identifierHash, invalid, notFound } from '@futuregrow/observability';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, record, requireRole } from '../../util.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { proposeAction } from '../m23-execution/gateway.js';
import { raiseAlert } from '../m24-governance/index.js';
import { registerWebhookHandler } from '../webhooks.js';

const STAFF = ['owner', 'admin', 'growth_operator'] as const;

/* ------------------------------------------------------------------ */
/* Creators & contracts                                                */
/* ------------------------------------------------------------------ */

export const CreatorInputSchema = z.object({
  name: z.string().min(1).max(200),
  handles: z.record(z.string().max(30), z.string().max(200)).default({}),
  contactEmail: z.string().email().nullable().default(null),
  contactConsentEvidenceId: z.string().uuid().nullable().default(null),
});

async function requireEvidence(tx: Tx, id: string, kinds: string[]) {
  const [e] = await tx.select().from(evidenceRecords).where(eq(evidenceRecords.id, id));
  if (!e) throw notFound('evidence');
  if (e.status !== 'admitted') throw invalid(`evidence ${id} is ${e.status}`);
  if (!kinds.includes(e.kind)) throw invalid(`evidence ${id} must be one of: ${kinds.join(', ')}`);
  return e;
}

export async function createCreator(tx: Tx, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, STAFF, 'managing creators');
  const input = CreatorInputSchema.parse(raw);
  if (input.contactEmail && !input.contactConsentEvidenceId) throw invalid('storing creator contact details requires consent/contract evidence');
  if (input.contactConsentEvidenceId) await requireEvidence(tx, input.contactConsentEvidenceId, ['consent', 'contract']);
  const [row] = await tx
    .insert(creators)
    .values({ tenantId, ...input })
    .returning();
  await audit(tx, tenantId, actor, 'creator.creator.created', { type: 'creator', id: row!.id }, { name: input.name });
  return row!;
}

export const ContractInputSchema = z.object({
  creatorId: z.string().uuid(),
  materialRelationship: z.enum(['paid', 'free_product', 'affiliate_commission', 'employee', 'family_or_friend', 'other']),
  commissionFraction: z.number().min(0).max(1).default(0),
  flatFeeMicros: z.number().int().nonnegative().default(0),
  currency: z.string().length(3),
  requiredDisclosures: z.array(z.string().min(2).max(60)).min(1).max(5),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).nullable().default(null),
  signedEvidenceId: z.string().uuid(),
  /** Free-text terms are screened: compensation may not depend on the sentiment of reviews (FTC 16 CFR 465). */
  terms: z.string().max(10_000).default(''),
});

const SENTIMENT_CONDITIONED = /\b(only (if|for) (positive|5[- ]star|good) (reviews?|ratings?)|in exchange for (a )?(positive|5[- ]star|good) (reviews?|ratings?)|must (be|leave) (positive|5[- ]star))\b/i;

export async function createContract(tx: Tx, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin'], 'signing creator contracts');
  const input = ContractInputSchema.parse(raw);
  if (SENTIMENT_CONDITIONED.test(input.terms)) throw invalid('compensation conditioned on review sentiment is prohibited');
  if (input.materialRelationship === 'affiliate_commission' && input.commissionFraction <= 0) throw invalid('affiliate contracts need a commission fraction');
  await requireEvidence(tx, input.signedEvidenceId, ['contract']);
  const [c] = await tx.select().from(creators).where(eq(creators.id, input.creatorId));
  if (!c) throw notFound('creator');
  const { terms, ...values } = input;
  const [row] = await tx
    .insert(creatorContracts)
    .values({ tenantId, ...values, currency: values.currency.toUpperCase(), startsAt: new Date(values.startsAt), endsAt: values.endsAt ? new Date(values.endsAt) : null })
    .returning();
  await audit(tx, tenantId, actor, 'creator.contract.signed', { type: 'creator_contract', id: row!.id }, { creatorId: input.creatorId, relationship: input.materialRelationship, termsLength: terms.length });
  return row!;
}

/* ------------------------------------------------------------------ */
/* Referral links & clicks                                             */
/* ------------------------------------------------------------------ */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newReferralCode(len = 8): string {
  const b = randomBytes(len);
  return [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
}

export async function createReferralLink(tx: Tx, tenantId: string, actor: Actor, input: { creatorId: string; contractId: string; destinationUrl: string }) {
  requireRole(actor, STAFF, 'creating referral links');
  let dest: URL;
  try {
    dest = new URL(input.destinationUrl);
  } catch {
    throw invalid('invalid destination URL');
  }
  if (dest.protocol !== 'https:') throw invalid('destination must be https');
  const [k] = await tx
    .select()
    .from(creatorContracts)
    .where(and(eq(creatorContracts.id, input.contractId), eq(creatorContracts.creatorId, input.creatorId)));
  if (!k) throw notFound('contract for this creator');
  const [row] = await tx.insert(referralLinks).values({ tenantId, creatorId: input.creatorId, contractId: input.contractId, code: newReferralCode(), destinationUrl: dest.toString() }).returning();
  await audit(tx, tenantId, actor, 'creator.referral_link.created', { type: 'referral_link', id: row!.id }, { code: row!.code });
  return row!;
}

export const CLICK_VELOCITY_PER_HOUR = 20;

/**
 * Public redirect: record a click (IP and user agent are keyed hashes, never stored raw) and
 * return the destination with `fg_ref` appended so the storefront can carry the code to checkout.
 */
export async function trackClick(deps: CoreDeps, code: string, client: { ip: string; userAgent: string }): Promise<string | null> {
  if (!/^[A-Z0-9]{6,16}$/.test(code)) return null;
  const [link] = await withSystem(deps.db, 'system:referrals', (tx) => tx.select().from(referralLinks).where(eq(referralLinks.code, code)));
  if (!link || link.status !== 'active') return null;
  const ipHash = identifierHash(deps.config.identifierPepper, 'ip', client.ip);
  const uaHash = identifierHash(deps.config.identifierPepper, 'ua', client.userAgent.slice(0, 500));
  await withTenant(deps.db, { tenantId: link.tenantId, actor: 'system:referrals' }, async (tx) => {
    await tx.insert(referralClicks).values({ tenantId: link.tenantId, linkId: link.id, ipHash, userAgentHash: uaHash });
    const [n] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(referralClicks)
      .where(and(eq(referralClicks.linkId, link.id), eq(referralClicks.ipHash, ipHash), gte(referralClicks.clickedAt, new Date(Date.now() - 3_600_000))));
    if ((n?.n ?? 0) > CLICK_VELOCITY_PER_HOUR) await flagOnce(tx, link.tenantId, { creatorId: link.creatorId, linkId: link.id, kind: 'click_velocity', details: { clicksLastHour: n!.n, ipHash: ipHash.slice(0, 16) } });
  });
  const dest = new URL(link.destinationUrl);
  dest.searchParams.set('fg_ref', link.code);
  return dest.toString();
}

async function flagOnce(tx: Tx, tenantId: string, f: { creatorId: string | null; linkId: string | null; kind: 'click_velocity' | 'self_referral' | 'refund_rate' | 'duplicate_customer' | 'incentivized_review'; details: Record<string, unknown> }) {
  const [open] = await tx
    .select({ id: fraudFlags.id })
    .from(fraudFlags)
    .where(and(eq(fraudFlags.kind, f.kind), eq(fraudFlags.status, 'open'), f.linkId ? eq(fraudFlags.linkId, f.linkId) : sql`true`, f.creatorId ? eq(fraudFlags.creatorId, f.creatorId) : sql`true`));
  if (open) return open.id;
  const [row] = await tx
    .insert(fraudFlags)
    .values({ tenantId, ...f })
    .returning();
  await audit(tx, tenantId, systemActor('referral-fraud'), 'creator.fraud.flagged', { type: 'fraud_flag', id: row!.id }, { kind: f.kind });
  return row!.id;
}

/* ------------------------------------------------------------------ */
/* Conversions & commission (Shopify webhooks)                         */
/* ------------------------------------------------------------------ */

interface ShopifyOrder {
  id: number | string;
  email?: string | null;
  created_at: string;
  currency: string;
  subtotal_price: string;
  financial_status?: string;
  landing_site?: string | null;
  note_attributes?: { name: string; value: string }[];
  discount_codes?: { code: string }[];
}

/** Find a referral code in an order: note attribute, landing-site query, or discount code. */
export function referralCodeOf(o: ShopifyOrder): string[] {
  const out: string[] = [];
  for (const a of o.note_attributes ?? []) if (a.name === 'fg_ref') out.push(a.value);
  if (o.landing_site) {
    try {
      const v = new URL(o.landing_site, 'https://shop.invalid').searchParams.get('fg_ref');
      if (v) out.push(v);
    } catch {
      /* ignore malformed landing site */
    }
  }
  for (const d of o.discount_codes ?? []) out.push(d.code);
  return [...new Set(out.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z0-9]{6,16}$/.test(c)))];
}

const toMicros = (s: string) => {
  const m = String(s)
    .trim()
    .match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) throw new Error(`invalid money amount ${s}`);
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? '').padEnd(6, '0'));
};

export const REFUND_RATE_FLAG = { minConversions: 10, maxRate: 0.3 };

export async function recordOrder(deps: CoreDeps, tenantId: string, o: ShopifyOrder) {
  const codes = referralCodeOf(o);
  if (codes.length === 0) return 'no_referral';
  const actor = systemActor('referral-attribution');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const links = await tx
      .select()
      .from(referralLinks)
      .where(
        sql`${referralLinks.code} in (${sql.join(
          codes.map((c) => sql`${c}`),
          sql`, `,
        )})`,
      );
    const link = links[0];
    if (!link) return 'unknown_code';
    const [contract] = await tx.select().from(creatorContracts).where(eq(creatorContracts.id, link.contractId));
    const [creator] = await tx.select().from(creators).where(eq(creators.id, link.creatorId));
    const occurredAt = new Date(o.created_at);
    const orderRef = `shopify:${o.id}`;
    const amount = toMicros(o.subtotal_price);
    const customerHash = o.email ? identifierHash(deps.config.identifierPepper, 'email', o.email) : null;
    const ev = await admitInternalEvidence(tx, tenantId, actor, {
      kind: 'api_response',
      sourceType: 'primary',
      owner: 'shopify',
      uri: `shopify://orders/${o.id}`,
      content: { orderId: String(o.id), subtotal: o.subtotal_price, currency: o.currency, financialStatus: o.financial_status ?? null, code: link.code },
      summary: `Order ${o.id} attributed to referral ${link.code}`,
      confidence: 1,
      license: 'merchant order data (Shopify webhook)',
      pii: 'none',
      permittedUses: ['analytics', 'causal_measurement'],
      externalPlatformTerms: 'shopify',
      observedAt: occurredAt,
      now: deps.clock.now(),
    });
    const [conv] = await tx.insert(referralConversions).values({ tenantId, linkId: link.id, orderRef, amountMicros: amount, currency: o.currency.toUpperCase(), customerHash, evidenceId: ev.evidenceId, occurredAt }).onConflictDoNothing().returning();
    if (!conv) return 'duplicate';
    await record(tx, tenantId, actor, 'creator.conversion.recorded', { type: 'referral_conversion', id: conv.id }, { linkId: link.id, amountMicros: amount, currency: conv.currency });

    const self = customerHash && creator?.contactEmail && identifierHash(deps.config.identifierPepper, 'email', creator.contactEmail) === customerHash;
    if (self) {
      await flagOnce(tx, tenantId, { creatorId: link.creatorId, linkId: link.id, kind: 'self_referral', details: { orderRef } });
      return 'self_referral_withheld';
    }
    if (customerHash) {
      const [other] = await tx
        .select({ n: sql<number>`count(distinct ${referralLinks.creatorId})::int` })
        .from(referralConversions)
        .innerJoin(referralLinks, eq(referralLinks.id, referralConversions.linkId))
        .where(and(eq(referralConversions.customerHash, customerHash), gte(referralConversions.occurredAt, new Date(occurredAt.getTime() - 30 * 86_400_000))));
      if ((other?.n ?? 0) > 1) await flagOnce(tx, tenantId, { creatorId: link.creatorId, linkId: link.id, kind: 'duplicate_customer', details: { orderRef, creators: other!.n } });
    }
    const active = contract && contract.startsAt <= occurredAt && (!contract.endsAt || contract.endsAt > occurredAt);
    if (!active || contract.commissionFraction <= 0) return 'recorded_no_commission';
    if (contract.currency !== conv.currency) {
      await raiseAlert(tx, tenantId, { kind: 'creator.commission.currency_mismatch', severity: 'warning', message: `Order ${orderRef} is in ${conv.currency} but the contract pays in ${contract.currency}; commission not accrued`, refs: { conversionId: conv.id }, dedupKey: `commission-currency:${conv.id}` });
      return 'currency_mismatch';
    }
    await tx
      .insert(commissionLedger)
      .values({ tenantId, creatorId: link.creatorId, conversionId: conv.id, kind: 'accrual', amountMicros: Math.round(amount * contract.commissionFraction), currency: contract.currency, ref: `accrual:${orderRef}` })
      .onConflictDoNothing();
    return 'accrued';
  });
}

interface ShopifyRefund {
  id: number | string;
  order_id: number | string;
  created_at: string;
  transactions?: { kind: string; status: string; amount: string; currency?: string }[];
}

export async function recordRefund(deps: CoreDeps, tenantId: string, r: ShopifyRefund) {
  const actor = systemActor('referral-attribution');
  const refunded = (r.transactions ?? []).filter((t) => t.kind === 'refund' && t.status === 'success').reduce((s, t) => s + toMicros(t.amount), 0);
  if (refunded <= 0) return 'no_refund_amount';
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const [conv] = await tx
      .select()
      .from(referralConversions)
      .where(eq(referralConversions.orderRef, `shopify:${r.order_id}`))
      .for('update');
    if (!conv) return 'not_referred';
    const total = Math.min(conv.amountMicros, conv.refundedMicros + refunded);
    const delta = total - conv.refundedMicros;
    if (delta <= 0) return 'already_refunded';
    await tx
      .update(referralConversions)
      .set({ refundedMicros: total, status: total >= conv.amountMicros ? 'refunded' : 'partially_refunded' })
      .where(eq(referralConversions.id, conv.id));
    const [link] = await tx.select().from(referralLinks).where(eq(referralLinks.id, conv.linkId));
    const [contract] = await tx.select().from(creatorContracts).where(eq(creatorContracts.id, link!.contractId));
    const [accrual] = await tx
      .select()
      .from(commissionLedger)
      .where(eq(commissionLedger.ref, `accrual:${conv.orderRef}`));
    if (accrual && contract) {
      // Claw back proportionally to the refunded share of the attributed amount.
      const claw = Math.round((accrual.amountMicros * delta) / conv.amountMicros);
      await tx
        .insert(commissionLedger)
        .values({ tenantId, creatorId: link!.creatorId, conversionId: conv.id, kind: 'clawback', amountMicros: -claw, currency: accrual.currency, ref: `clawback:shopify:${r.id}` })
        .onConflictDoNothing();
    }
    const [stats] = await tx
      .select({ n: sql<number>`count(*)::int`, refunded: sql<number>`count(*) filter (where ${referralConversions.refundedMicros} > 0)::int` })
      .from(referralConversions)
      .innerJoin(referralLinks, eq(referralLinks.id, referralConversions.linkId))
      .where(eq(referralLinks.creatorId, link!.creatorId));
    if (stats && stats.n >= REFUND_RATE_FLAG.minConversions && stats.refunded / stats.n > REFUND_RATE_FLAG.maxRate) {
      await flagOnce(tx, tenantId, { creatorId: link!.creatorId, linkId: null, kind: 'refund_rate', details: { conversions: stats.n, refunded: stats.refunded } });
    }
    return 'clawed_back';
  });
}

registerWebhookHandler('shopify', async ({ deps, tenantId, topic, payload }) => {
  if (!tenantId) return 'ignored';
  if (topic === 'orders/create' || topic === 'orders/paid') {
    const r = await recordOrder(deps, tenantId, payload as ShopifyOrder);
    return r === 'no_referral' || r === 'unknown_code' || r === 'duplicate' ? 'ignored' : 'processed';
  }
  if (topic === 'refunds/create') {
    const r = await recordRefund(deps, tenantId, payload as ShopifyRefund);
    return r === 'clawed_back' ? 'processed' : 'ignored';
  }
  return 'ignored';
});

/* ------------------------------------------------------------------ */
/* Content submissions: disclosure fails closed                        */
/* ------------------------------------------------------------------ */

/** Disclosure must be present and conspicuous: within the first 150 characters (not buried in hashtags). */
export function disclosureCheck(text: string, required: string[]) {
  const lower = text.toLowerCase();
  const found = required.map((d) => ({ disclosure: d, index: lower.indexOf(d.toLowerCase()) }));
  const present = found.filter((f) => f.index >= 0);
  const conspicuous = present.filter((f) => f.index < 150 || text.length < 300);
  const isReview = /\b(review|rating|stars?|recommend(ed)?)\b/i.test(text);
  return { passed: conspicuous.length > 0, present: present.map((p) => p.disclosure), conspicuous: conspicuous.map((p) => p.disclosure), required, isReview };
}

export async function submitContent(tx: Tx, tenantId: string, actor: Actor, input: { creatorId: string; contractId: string; contentUrl?: string | null; contentText: string }) {
  requireRole(actor, STAFF, 'recording creator submissions');
  if (!input.contentText.trim()) throw invalid('content text (caption/script) is required');
  const [k] = await tx
    .select()
    .from(creatorContracts)
    .where(and(eq(creatorContracts.id, input.contractId), eq(creatorContracts.creatorId, input.creatorId)));
  if (!k) throw notFound('contract for this creator');
  const check = disclosureCheck(input.contentText, k.requiredDisclosures);
  const [row] = await tx
    .insert(creatorSubmissions)
    .values({ tenantId, creatorId: input.creatorId, contractId: input.contractId, contentUrl: input.contentUrl ?? null, contentText: input.contentText, disclosureCheck: check, status: check.passed ? 'pending_review' : 'rejected_missing_disclosure' })
    .returning();
  if (!check.passed && check.isReview) await flagOnce(tx, tenantId, { creatorId: input.creatorId, linkId: null, kind: 'incentivized_review', details: { submissionId: row!.id } });
  await record(tx, tenantId, actor, 'creator.content.submitted', { type: 'creator_submission', id: row!.id }, { passed: check.passed });
  return row!;
}

export async function reviewSubmission(tx: Tx, tenantId: string, actor: Actor, id: string, decision: 'approved' | 'rejected') {
  requireRole(actor, ['owner', 'admin', 'approver', 'legal_approver'], 'reviewing creator content');
  const [s] = await tx.select().from(creatorSubmissions).where(eq(creatorSubmissions.id, id)).for('update');
  if (!s) throw notFound('submission');
  if (s.status !== 'pending_review') throw invalid(`submission is ${s.status}`);
  if (decision === 'approved' && !(s.disclosureCheck as { passed?: boolean }).passed) throw invalid('content without a conspicuous disclosure cannot be approved');
  const [row] = await tx
    .update(creatorSubmissions)
    .set({ status: decision, reviewedBy: actorRef(actor) })
    .where(eq(creatorSubmissions.id, id))
    .returning();
  await audit(tx, tenantId, actor, `creator.submission.${decision}`, { type: 'creator_submission', id }, {});
  return row!;
}

/* ------------------------------------------------------------------ */
/* Balances & payouts                                                  */
/* ------------------------------------------------------------------ */

/** Commission only becomes payable after the refund window, net of clawbacks and prior payouts. */
export const PAYABLE_AFTER_DAYS = 30;

export async function creatorBalance(tx: DbOrTx, creatorId: string, now: Date) {
  const r = await tx.execute<{ currency: string; accrued: number; clawed: number; paid: number; payable: number }>(sql`
    select l.currency,
      coalesce(sum(l.amount_micros) filter (where l.kind = 'accrual'), 0)::bigint as accrued,
      coalesce(sum(l.amount_micros) filter (where l.kind = 'clawback'), 0)::bigint as clawed,
      coalesce(sum(l.amount_micros) filter (where l.kind = 'payout'), 0)::bigint as paid,
      coalesce(sum(l.amount_micros) filter (where l.kind <> 'accrual' or c.occurred_at < ${new Date(now.getTime() - PAYABLE_AFTER_DAYS * 86_400_000)}), 0)::bigint as payable
    from commission_ledger l left join referral_conversions c on c.id = l.conversion_id
    where l.creator_id = ${creatorId} group by l.currency`);
  return r.rows.map((x) => ({ ...x, accrued: Number(x.accrued), clawed: Number(x.clawed), paid: Number(x.paid), payable: Math.max(0, Number(x.payable)) }));
}

/**
 * Payouts go through M23 like every money movement. The payout provider is unspecified
 * (B-015), so the action type is unsupported and policy denies it; nothing is ever paid here.
 */
export async function proposePayout(deps: CoreDeps, tenantId: string, actor: Actor, creatorId: string) {
  requireRole(actor, ['owner', 'admin', 'finance_approver'], 'proposing payouts');
  const bal = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (tx) => creatorBalance(tx, creatorId, deps.clock.now()));
  const payable = bal.filter((b) => b.payable > 0);
  if (payable.length === 0) throw new FgError('CONFLICT', 'nothing payable yet', 409);
  return proposeAction(deps, tenantId, actor, {
    actionType: 'creator.payout',
    connectionId: null,
    target: { creatorId },
    params: { creatorId, amounts: payable.map((b) => ({ currency: b.currency, amountMicros: b.payable })) },
    risk: { spendDeltaMicros: payable[0]!.payable, currency: payable[0]!.currency },
    idempotencyKey: `payout:${creatorId}:${deps.clock.now().toISOString().slice(0, 10)}`,
  });
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function listCreators(tx: DbOrTx) {
  return tx.select().from(creators).orderBy(creators.name).limit(500);
}

export async function creatorDetail(tx: DbOrTx, id: string, now: Date) {
  const [c] = await tx.select().from(creators).where(eq(creators.id, id));
  if (!c) throw notFound('creator');
  const [contracts, links, submissions, flags] = await sequential([
    tx.select().from(creatorContracts).where(eq(creatorContracts.creatorId, id)),
    tx.select().from(referralLinks).where(eq(referralLinks.creatorId, id)),
    tx.select().from(creatorSubmissions).where(eq(creatorSubmissions.creatorId, id)).orderBy(desc(creatorSubmissions.createdAt)).limit(100),
    tx.select().from(fraudFlags).where(eq(fraudFlags.creatorId, id)).orderBy(desc(fraudFlags.createdAt)).limit(100),
  ]);
  const balance = await creatorBalance(tx, id, now);
  return { creator: { ...c, contactEmail: c.contactEmail ? `${c.contactEmail.slice(0, 2)}…` : null }, contracts, links, submissions, flags, balance };
}

export async function listFraudFlags(tx: DbOrTx, status = 'open') {
  return tx.select().from(fraudFlags).where(eq(fraudFlags.status, status)).orderBy(desc(fraudFlags.createdAt)).limit(200);
}

export async function resolveFraudFlag(tx: Tx, tenantId: string, actor: Actor, id: string, status: 'dismissed' | 'confirmed') {
  requireRole(actor, ['owner', 'admin', 'finance_approver'], 'resolving fraud flags');
  const [f] = await tx.update(fraudFlags).set({ status }).where(eq(fraudFlags.id, id)).returning();
  if (!f) throw notFound('fraud flag');
  await audit(tx, tenantId, actor, `creator.fraud.${status}`, { type: 'fraud_flag', id }, {});
  return f;
}
