import { croHypotheses, type DbOrTx, evidenceRecords, offers, priceGuardrails, type Tx, withTenant } from '@futuregrow/db';
import { conflict, invalid, notFound } from '@futuregrow/observability';
import { desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, requireMfa, requireRole } from '../../util.js';
import { lintCopy } from '../m03-knowledge/index.js';
import { proposeAction } from '../m23-execution/gateway.js';
import { registerHooks } from '../m23-execution/registry.js';

const FINANCE = ['owner', 'finance_approver'] as const;

export const GuardrailSchema = z
  .object({
    productRef: z.string().min(1).max(200),
    currency: z.string().length(3),
    listPriceMicros: z.number().int().positive(),
    unitCostMicros: z.number().int().nonnegative(),
    minPriceMicros: z.number().int().nonnegative(),
    maxDiscountFraction: z.number().min(0).lt(1),
    minMarginFraction: z.number().gt(-1).lt(1),
    inventoryAvailable: z.number().int().nonnegative().nullable().default(null),
  })
  .refine((g) => g.minPriceMicros <= g.listPriceMicros, 'min price cannot exceed list price');

/** Pricing authorisation: only finance approvers set the boundaries offers must respect. */
export async function setGuardrail(tx: Tx, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, FINANCE, 'setting price guardrails');
  requireMfa(actor, 'setting price guardrails');
  const g = GuardrailSchema.parse(raw);
  const [row] = await tx
    .insert(priceGuardrails)
    .values({ tenantId, ...g, approvedBy: actorRef(actor) })
    .onConflictDoUpdate({ target: [priceGuardrails.tenantId, priceGuardrails.productRef], set: { ...g, approvedBy: actorRef(actor), updatedAt: new Date() } })
    .returning();
  await audit(tx, tenantId, actor, 'offer.guardrail.set', { type: 'price_guardrail', id: row!.id }, g);
  return row!;
}

export const OfferSchema = z.object({
  name: z.string().min(3).max(200),
  kind: z.enum(['percent_discount', 'fixed_discount', 'bundle', 'trial_extension', 'free_shipping']),
  productRefs: z.array(z.string()).min(1).max(50),
  params: z.object({
    percentage: z.number().gt(0).lt(1).optional(),
    amountMicros: z.number().int().positive().optional(),
    bundlePriceMicros: z.number().int().positive().optional(),
    extraTrialDays: z.number().int().positive().max(365).optional(),
    code: z
      .string()
      .regex(/^[A-Z0-9_-]{4,40}$/)
      .optional(),
    usageLimit: z.number().int().positive().optional(),
  }),
  copy: z.string().max(2000).default(''),
  claimIds: z.array(z.string().uuid()).default([]),
  scarcityClaim: z.string().max(300).nullable().default(null),
  scarcityEvidenceId: z.string().uuid().nullable().default(null),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).nullable().default(null),
});

export interface ProductEconomics {
  productRef: string;
  listPriceMicros: number;
  offerPriceMicros: number;
  discountFraction: number;
  marginFraction: number;
  violations: string[];
}

/** Deterministic economics against approved guardrails; missing guardrails are violations. */
export function offerEconomics(kind: z.infer<typeof OfferSchema>['kind'], params: z.infer<typeof OfferSchema>['params'], guardrails: (typeof priceGuardrails.$inferSelect)[], productRefs: string[]): ProductEconomics[] {
  const totalList = productRefs.reduce((s, p) => s + (guardrails.find((g) => g.productRef === p)?.listPriceMicros ?? 0), 0);
  return productRefs.map((ref) => {
    const g = guardrails.find((x) => x.productRef === ref);
    if (!g) return { productRef: ref, listPriceMicros: 0, offerPriceMicros: 0, discountFraction: 0, marginFraction: 0, violations: ['no approved price guardrail for this product [U]'] };
    let price = g.listPriceMicros;
    if (kind === 'percent_discount') price = Math.round(g.listPriceMicros * (1 - (params.percentage ?? 0)));
    if (kind === 'fixed_discount') price = g.listPriceMicros - (params.amountMicros ?? 0);
    if (kind === 'bundle' && params.bundlePriceMicros && totalList > 0) price = Math.round((params.bundlePriceMicros * g.listPriceMicros) / totalList);
    const discount = 1 - price / g.listPriceMicros;
    const margin = price > 0 ? (price - g.unitCostMicros) / price : -1;
    const violations: string[] = [];
    if (discount > g.maxDiscountFraction + 1e-9) violations.push(`discount ${(discount * 100).toFixed(1)}% exceeds ${(g.maxDiscountFraction * 100).toFixed(1)}%`);
    if (price < g.minPriceMicros) violations.push('price below approved minimum');
    if (margin < g.minMarginFraction - 1e-9) violations.push(`margin ${(margin * 100).toFixed(1)}% below ${(g.minMarginFraction * 100).toFixed(1)}%`);
    if (g.inventoryAvailable === 0) violations.push('no inventory available');
    return { productRef: ref, listPriceMicros: g.listPriceMicros, offerPriceMicros: price, discountFraction: discount, marginFraction: margin, violations };
  });
}

export async function createOffer(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'creating offers');
  const input = OfferSchema.parse(raw);
  if (input.kind === 'percent_discount' && !input.params.percentage) throw invalid('percent_discount requires params.percentage');
  if (input.kind === 'fixed_discount' && !input.params.amountMicros) throw invalid('fixed_discount requires params.amountMicros');
  if (input.endsAt && Date.parse(input.endsAt) <= Date.parse(input.startsAt)) throw invalid('offer must end after it starts');
  const guardrails = await tx.select().from(priceGuardrails).where(inArray(priceGuardrails.productRef, input.productRefs));
  const economics = offerEconomics(input.kind, input.params, guardrails, input.productRefs);
  const violations = economics.flatMap((e) => e.violations.map((v) => `${e.productRef}: ${v}`));
  // Truthful scarcity: a scarcity/urgency statement must be backed by admitted evidence (e.g. inventory feed).
  if (input.scarcityClaim) {
    // Defence in depth with the offers_scarcity_chk constraint: never persist unbacked urgency.
    if (!input.scarcityEvidenceId) throw invalid('a scarcity/urgency claim requires admitted evidence (e.g. an inventory feed)');
    {
      const [ev] = await tx.select().from(evidenceRecords).where(eq(evidenceRecords.id, input.scarcityEvidenceId));
      if (!ev || ev.status !== 'admitted') violations.push('scarcity evidence is not admitted');
    }
  }
  const lint = await lintCopy(tx, [input.copy, input.scarcityClaim ?? ''].join('\n'), { claimIds: input.claimIds, now: deps.clock.now() });
  if (!lint.passed) violations.push(...lint.violations.filter((v) => v.severity === 'block').map((v) => `copy: ${v.code}`));
  const [row] = await tx
    .insert(offers)
    .values({
      tenantId,
      name: input.name,
      kind: input.kind,
      productRefs: input.productRefs,
      params: { ...input.params, copy: input.copy },
      economics: { products: economics },
      guardrailCheck: { passed: violations.length === 0, violations, lint },
      claimIds: input.claimIds,
      scarcityClaim: input.scarcityClaim,
      scarcityEvidenceId: input.scarcityEvidenceId,
      status: violations.length ? 'guardrail_failed' : 'draft',
      startsAt: new Date(input.startsAt),
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      createdBy: actorRef(actor),
    })
    .returning();
  await audit(tx, tenantId, actor, 'offer.offer.created', { type: 'offer', id: row!.id }, { status: row!.status, violations });
  return row!;
}

export async function approveOffer(tx: Tx, tenantId: string, actor: Actor, id: string) {
  requireRole(actor, FINANCE, 'approving offers');
  requireMfa(actor, 'approving offers');
  const [o] = await tx.select().from(offers).where(eq(offers.id, id)).for('update');
  if (!o) throw notFound('offer');
  if (o.status !== 'draft') throw conflict(`offer is ${o.status}`);
  if (o.createdBy === actorRef(actor)) throw invalid('offers must be approved by someone other than their author');
  const [row] = await tx.update(offers).set({ status: 'approved' }).where(eq(offers.id, id)).returning();
  await audit(tx, tenantId, actor, 'offer.offer.approved', { type: 'offer', id }, {});
  return row!;
}

/** Launch an approved percent-discount offer as a Shopify discount code via M23. */
export async function proposeShopifyDiscount(deps: CoreDeps, tenantId: string, actor: Actor, offerId: string, input: { connectionId: string; geographies: string[]; evidenceIds?: string[] }) {
  const o = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => (await tx.select().from(offers).where(eq(offers.id, offerId)))[0] ?? null);
  if (!o) throw notFound('offer');
  if (o.status !== 'approved') throw conflict('only approved offers can be launched');
  if (o.kind !== 'percent_discount') throw invalid('Shopify launch currently supports percent discounts');
  const p = o.params as { percentage: number; code?: string; usageLimit?: number };
  if (!p.code) throw invalid('offer needs a discount code');
  return proposeAction(deps, tenantId, actor, {
    actionType: 'commerce.shopify.create_discount',
    connectionId: input.connectionId,
    params: { offerId, title: o.name, code: p.code, percentage: p.percentage, startsAt: o.startsAt!.toISOString(), endsAt: o.endsAt?.toISOString() ?? null, usageLimit: p.usageLimit ?? null },
    evidenceIds: input.evidenceIds ?? [],
    risk: { geographies: input.geographies },
    idempotencyKey: `offer-launch:${offerId}`,
  });
}

registerHooks('commerce.shopify.create_discount', {
  async onVerified(tx, action) {
    const offerId = (action.params as { offerId: string }).offerId;
    await tx.update(offers).set({ status: 'live' }).where(eq(offers.id, offerId));
    await audit(tx, action.tenantId, systemActor('offers'), 'offer.offer.live', { type: 'offer', id: offerId }, { actionId: action.id });
  },
});

/* ------------------------------------------------------------------ */
/* CRO hypotheses with dark-pattern screening                          */
/* ------------------------------------------------------------------ */

const DARK_PATTERNS: { code: string; re: RegExp }[] = [
  { code: 'preselected_addon', re: /\b(pre-?select|pre-?check|default (to )?(on|checked)|opt[- ]out by default)\b/i },
  { code: 'confirmshaming', re: /\b(no thanks,? i (don'?t|do not) (want|like)|i prefer (paying|losing)|i hate saving)\b/i },
  { code: 'hidden_costs', re: /\b(hide|hidden|reveal (fees?|costs?) (at|on) (checkout|the last step)|drip pricing)\b/i },
  { code: 'obstruct_cancellation', re: /\b(hard(er)? to cancel|remove (the )?cancel(lation)? (button|link)|require (a )?call to cancel|hide (the )?(cancel|unsubscribe))\b/i },
  { code: 'fake_urgency', re: /\b(fake|reset(ting)?|fictional|artificial) (countdown|timer|urgency|scarcity|stock)\b/i },
  { code: 'sneak_into_basket', re: /\b(auto(matically)? add (to )?(the )?(cart|basket)|sneak)\b/i },
  { code: 'forced_continuity', re: /\b(silently (convert|renew)|no reminder before (charging|renewal)|auto[- ]renew without notice)\b/i },
  { code: 'consent_obstruction', re: /\b(hide (the )?(reject|decline)|make (reject|decline) harder|bury (the )?opt[- ]out)\b/i },
  { code: 'trick_question', re: /\b(double negative|confusing (opt[- ]in|wording))\b/i },
];

export function darkPatternCheck(text: string): { passed: boolean; findings: string[] } {
  const findings = DARK_PATTERNS.filter((d) => d.re.test(text)).map((d) => d.code);
  return { passed: findings.length === 0, findings };
}

export const CroSchema = z.object({
  pageUrl: z.string().url(),
  hypothesis: z.string().min(10).max(2000),
  changes: z
    .array(z.object({ element: z.string().min(1).max(200), change: z.string().min(3).max(1000) }))
    .min(1)
    .max(20),
  evidenceIds: z.array(z.string().uuid()).min(1),
});

export async function createCroHypothesis(tx: Tx, tenantId: string, actor: Actor, raw: unknown) {
  const input = CroSchema.parse(raw);
  const check = darkPatternCheck([input.hypothesis, ...input.changes.map((c) => `${c.element}: ${c.change}`)].join('\n'));
  const [row] = await tx
    .insert(croHypotheses)
    .values({ tenantId, ...input, darkPatternCheck: check, status: check.passed ? 'draft' : 'blocked_dark_pattern', createdBy: actorRef(actor) })
    .returning();
  await audit(tx, tenantId, actor, 'offer.cro_hypothesis.created', { type: 'cro_hypothesis', id: row!.id }, { status: row!.status, findings: check.findings });
  return row!;
}

export async function listOffers(tx: DbOrTx) {
  return tx.select().from(offers).orderBy(desc(offers.createdAt)).limit(200);
}

export async function listGuardrails(tx: DbOrTx) {
  return tx.select().from(priceGuardrails).orderBy(priceGuardrails.productRef);
}

export async function listCro(tx: DbOrTx) {
  return tx.select().from(croHypotheses).orderBy(desc(croHypotheses.createdAt)).limit(200);
}
