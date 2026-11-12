import { randomBytes } from 'node:crypto';
import { acquisitionTools, claims, type DbOrTx, experiments, keywordMetrics, leads, searchVisibilityObservations, type Tx, withSystem, withTenant } from '@futuregrow/db';
import { conflict, invalid, notFound, sha256Hex } from '@futuregrow/observability';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { audit, clipText, normalizeText, requireMfa, requireRole } from '../../util.js';
import { getBrand } from '../brands/index.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { ingestEventsInTransaction, recordConsent } from '../m02-customers/index.js';
import { assign, logExposure, logOutcome } from '../m10-experiments/index.js';
import { PACKS } from '../studio/curriculum.js';
import { getBrandConfig, requireFeature } from './settings.js';
import { GW_ACTOR } from './signals.js';

/**
 * F4 Search & Utility Capture Engine (D-054).
 *
 * Acquisition tools are small, genuinely useful utilities hosted by FUTUREGROW's own web app
 * (/t/?id=…) and embeddable on the brand's site; they are not a second website platform. Every
 * number a tool shows is either the visitor's own input or operator-entered data with a source
 * and a verification date; a missing value is shown as missing, never estimated. Leads are kept
 * only with explicit consent; events are first-party (M02) and respect the analytics choice.
 *
 * AI-search visibility uses audited manual imports (or an approved provider API, none bundled);
 * consumer AI interfaces are never automated and no ranking is promised.
 */
const DAY = 86_400_000;
const httpsUrl = z.string().url().startsWith('https://');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/* ------------------------------------------------------------------ */
/* Template schemas and calculations                                    */
/* ------------------------------------------------------------------ */

const CourierSchema = z.object({
  name: z.string().min(1).max(80),
  sourceUrl: httpsUrl,
  verifiedAt: isoDate,
  rates: z
    .array(z.object({ zone: z.string().min(1).max(60), maxWeightKg: z.number().positive().max(100), price: z.number().nonnegative() }))
    .min(1)
    .max(40),
  codFeePct: z.number().min(0).max(20).nullable().default(null),
  returnFee: z.number().nonnegative().nullable().default(null),
});

export const TEMPLATE_CONFIG = {
  courier_comparison: z.object({ currency: z.string().length(3).default('BDT'), zones: z.array(z.string().min(1).max(60)).min(1).max(20), couriers: z.array(CourierSchema).min(1).max(15) }),
  cod_reconciliation: z.object({ currency: z.string().length(3).default('BDT') }),
  seller_cost_calculator: z.object({ currency: z.string().length(3).default('BDT') }),
  vocabulary_assessment: z.object({ pack: z.literal('eps-topik-bn').default('eps-topik-bn'), itemsPerLevel: z.number().int().min(3).max(15).default(5), seed: z.string().max(40).default('v1') }),
  practice_quiz: z.object({ pack: z.literal('eps-topik-bn').default('eps-topik-bn'), topic: z.string().max(40).nullable().default(null), questions: z.number().int().min(3).max(20).default(8), seed: z.string().max(40).default('v1') }),
  readiness_assessment: z.object({
    questions: z
      .array(
        z.object({
          id: z.string().min(1).max(40),
          text: z.string().min(3).max(300),
          options: z
            .array(z.object({ label: z.string().min(1).max(200), points: z.number().int().min(0).max(10) }))
            .min(2)
            .max(6),
        }),
      )
      .min(2)
      .max(20),
    bands: z
      .array(z.object({ min: z.number().int().min(0), label: z.string().min(1).max(80), advice: z.string().min(1).max(500) }))
      .min(2)
      .max(6),
  }),
} as const;
export type ToolTemplate = keyof typeof TEMPLATE_CONFIG;

export const TEMPLATE_INFO: Record<ToolTemplate, { title: string; brands: string; methodology: string; data: 'operator' | 'visitor' | 'curriculum' }> = {
  courier_comparison: {
    title: 'Courier comparison',
    brands: 'e-commerce sellers (e.g. Ecoms BD)',
    methodology:
      'For the chosen zone and parcel weight, each courier’s delivery fee is the price of the smallest published weight bracket that fits; COD fee = COD amount × the courier’s published COD %. Couriers with no published bracket or COD % show “not published”. Rates are the operator’s copies of each courier’s public rate card on the date shown.',
    data: 'operator',
  },
  cod_reconciliation: {
    title: 'COD reconciliation estimator',
    brands: 'e-commerce sellers',
    methodology: 'Delivered orders = orders × (1 − return rate). Expected payout = delivered × average COD − delivered × (delivery fee + average COD × COD %) − returned × return fee. Outstanding = expected payout − amount already received. Every value is your own input.',
    data: 'visitor',
  },
  seller_cost_calculator: {
    title: 'Seller operations cost calculator',
    brands: 'e-commerce sellers',
    methodology: 'Per order: revenue − product cost − shipping − packaging − platform fee % − payment fee % − ad spend per order; returns cost return rate × return cost. Break-even ad spend is the ad spend at which the margin is zero. Every value is your own input.',
    data: 'visitor',
  },
  vocabulary_assessment: {
    title: 'Korean vocabulary check',
    brands: 'language learning (e.g. EPS TOPIK Bangla)',
    methodology: 'Words are drawn from the verified EPS-TOPIK lesson bank, the same number per level. The result is the share answered correctly per level; it is a self-check, not an official EPS-TOPIK score.',
    data: 'curriculum',
  },
  practice_quiz: { title: 'Practice quiz', brands: 'language learning', methodology: 'Multiple-choice meaning questions from the verified lesson bank; distractors come from the same bank. Your score is the number answered correctly.', data: 'curriculum' },
  readiness_assessment: {
    title: 'Learning-readiness assessment',
    brands: 'any brand with a learning or onboarding journey',
    methodology: 'Each answer has the points shown in the tool’s configuration; the total maps to the band whose minimum it reaches. The weights are the operator’s and are published with the tool.',
    data: 'operator',
  },
};

const num = (v: unknown, name: string, opts: { min?: number; max?: number } = {}) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) throw invalid(`${name} must be a number`);
  if (opts.min !== undefined && n < opts.min) throw invalid(`${name} must be at least ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw invalid(`${name} must be at most ${opts.max}`);
  return n;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

function seeded(seed: string) {
  let h = Number.parseInt(sha256Hex(seed).slice(0, 8), 16);
  return () => {
    h = (h * 1103515245 + 12345) % 2 ** 31;
    return h / 2 ** 31;
  };
}

function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

interface Question {
  id: string;
  prompt: string;
  options: string[];
  answer: number;
  level: 1 | 2;
  explanation: string;
}

/** Questions built only from the verified curriculum bank (deterministic per seed). */
export function curriculumQuestions(packId: string, opts: { seed: string; perLevel?: number; total?: number; topic?: string | null }): Question[] {
  const pack = PACKS[packId];
  if (!pack) throw invalid(`unknown curriculum pack ${packId}`);
  const rnd = seeded(`${packId}:${opts.seed}:${opts.topic ?? '*'}`);
  const pool = pack.vocab.filter((v) => !opts.topic || v.topic === opts.topic);
  const pick = (level: 1 | 2, n: number) =>
    shuffle(
      pool.filter((v) => v.level === level),
      rnd,
    ).slice(0, n);
  const chosen = opts.perLevel ? [...pick(1, opts.perLevel), ...pick(2, opts.perLevel)] : shuffle(pool, rnd).slice(0, opts.total ?? 8);
  return chosen.map((v) => {
    const distractors = shuffle(
      pack.vocab.filter((x) => x.id !== v.id && x.bn !== v.bn),
      rnd,
    )
      .slice(0, 3)
      .map((x) => x.bn);
    const options = shuffle([v.bn, ...distractors], rnd);
    return { id: v.id, prompt: `“${v.ko}” (${v.rr}) — অর্থ কী?`, options, answer: options.indexOf(v.bn), level: v.level, explanation: `${v.ko} = ${v.bn}. উদাহরণ: ${v.example.ko} — ${v.example.bn}` };
  });
}

function questionsFor(template: ToolTemplate, config: Record<string, unknown>): Question[] {
  if (template === 'vocabulary_assessment') {
    const c = TEMPLATE_CONFIG.vocabulary_assessment.parse(config);
    return curriculumQuestions(c.pack, { seed: c.seed, perLevel: c.itemsPerLevel });
  }
  if (template === 'practice_quiz') {
    const c = TEMPLATE_CONFIG.practice_quiz.parse(config);
    return curriculumQuestions(c.pack, { seed: c.seed, total: c.questions, topic: c.topic });
  }
  return [];
}

/** What a visitor sees: configuration without answers. */
export function publicDefinition(template: ToolTemplate, config: Record<string, unknown>) {
  switch (template) {
    case 'courier_comparison': {
      const c = TEMPLATE_CONFIG.courier_comparison.parse(config);
      return { currency: c.currency, zones: c.zones, couriers: c.couriers.map((x) => ({ name: x.name, sourceUrl: x.sourceUrl, verifiedAt: x.verifiedAt })), inputs: ['zone', 'weightKg', 'codAmount'] };
    }
    case 'cod_reconciliation':
      return { currency: TEMPLATE_CONFIG.cod_reconciliation.parse(config).currency, inputs: ['orders', 'avgCodAmount', 'deliveryFee', 'codFeePct', 'returnRatePct', 'returnFee', 'alreadyReceived'] };
    case 'seller_cost_calculator':
      return { currency: TEMPLATE_CONFIG.seller_cost_calculator.parse(config).currency, inputs: ['sellingPrice', 'unitCost', 'shipping', 'packaging', 'platformFeePct', 'paymentFeePct', 'adSpendPerOrder', 'returnRatePct', 'returnCost'] };
    case 'vocabulary_assessment':
    case 'practice_quiz':
      return { questions: questionsFor(template, config).map(({ answer: _a, explanation: _e, ...q }) => q) };
    case 'readiness_assessment': {
      const c = TEMPLATE_CONFIG.readiness_assessment.parse(config);
      return { questions: c.questions.map((q) => ({ id: q.id, text: q.text, options: q.options.map((o) => o.label) })), bands: c.bands.map((b) => ({ min: b.min, label: b.label })) };
    }
  }
}

/** The real calculation for each template. Pure; throws INVALID on bad input. */
export function evaluateTool(template: ToolTemplate, config: Record<string, unknown>, inputs: Record<string, unknown>): Record<string, unknown> {
  switch (template) {
    case 'courier_comparison': {
      const c = TEMPLATE_CONFIG.courier_comparison.parse(config);
      const zone = String(inputs.zone ?? '');
      if (!c.zones.includes(zone)) throw invalid(`zone must be one of ${c.zones.join(', ')}`);
      const weight = num(inputs.weightKg, 'weightKg', { min: 0.01, max: 100 });
      const cod = num(inputs.codAmount ?? 0, 'codAmount', { min: 0 });
      const rows = c.couriers.map((x) => {
        const bracket = x.rates.filter((r) => r.zone === zone && r.maxWeightKg >= weight).sort((a, b) => a.maxWeightKg - b.maxWeightKg)[0];
        const delivery = bracket ? bracket.price : null;
        const codFee = x.codFeePct === null ? null : r2((cod * x.codFeePct) / 100);
        const missing = [...(delivery === null ? ['no published rate for this zone and weight'] : []), ...(cod > 0 && codFee === null ? ['COD fee not published'] : [])];
        return { courier: x.name, deliveryFee: delivery, codFee, total: delivery === null || (cod > 0 && codFee === null) ? null : r2(delivery + (codFee ?? 0)), returnFee: x.returnFee, source: x.sourceUrl, verifiedAt: x.verifiedAt, missing };
      });
      const ranked = [...rows].sort((a, b) => (a.total ?? Number.POSITIVE_INFINITY) - (b.total ?? Number.POSITIVE_INFINITY));
      return {
        currency: c.currency,
        zone,
        weightKg: weight,
        codAmount: cod,
        couriers: ranked,
        cheapestKnown: ranked.find((x) => x.total !== null)?.courier ?? null,
        note: 'Fees are copies of each courier’s public rate card on the date shown; check the courier before booking. No delivery time or service quality is implied.',
      };
    }
    case 'cod_reconciliation': {
      const orders = num(inputs.orders, 'orders', { min: 0, max: 1_000_000 });
      const avg = num(inputs.avgCodAmount, 'avgCodAmount', { min: 0 });
      const fee = num(inputs.deliveryFee, 'deliveryFee', { min: 0 });
      const pct = num(inputs.codFeePct, 'codFeePct', { min: 0, max: 100 });
      const ret = num(inputs.returnRatePct, 'returnRatePct', { min: 0, max: 100 });
      const retFee = num(inputs.returnFee ?? 0, 'returnFee', { min: 0 });
      const received = num(inputs.alreadyReceived ?? 0, 'alreadyReceived', { min: 0 });
      const delivered = orders * (1 - ret / 100);
      const returned = orders - delivered;
      const gross = delivered * avg;
      const fees = delivered * (fee + (avg * pct) / 100) + returned * retFee;
      const payout = gross - fees;
      return { deliveredOrders: r2(delivered), returnedOrders: r2(returned), grossCodCollected: r2(gross), courierCharges: r2(fees), expectedPayout: r2(payout), outstanding: r2(payout - received), currency: TEMPLATE_CONFIG.cod_reconciliation.parse(config).currency };
    }
    case 'seller_cost_calculator': {
      const price = num(inputs.sellingPrice, 'sellingPrice', { min: 0 });
      const cost = num(inputs.unitCost, 'unitCost', { min: 0 });
      const ship = num(inputs.shipping ?? 0, 'shipping', { min: 0 });
      const pack = num(inputs.packaging ?? 0, 'packaging', { min: 0 });
      const platform = num(inputs.platformFeePct ?? 0, 'platformFeePct', { min: 0, max: 100 });
      const payment = num(inputs.paymentFeePct ?? 0, 'paymentFeePct', { min: 0, max: 100 });
      const ads = num(inputs.adSpendPerOrder ?? 0, 'adSpendPerOrder', { min: 0 });
      const ret = num(inputs.returnRatePct ?? 0, 'returnRatePct', { min: 0, max: 100 });
      const retCost = num(inputs.returnCost ?? 0, 'returnCost', { min: 0 });
      const fees = (price * (platform + payment)) / 100;
      const returnsCost = (ret / 100) * retCost;
      const beforeAds = price - cost - ship - pack - fees - returnsCost;
      const margin = beforeAds - ads;
      return {
        revenue: price,
        costs: { product: cost, shipping: ship, packaging: pack, fees: r2(fees), returns: r2(returnsCost), ads },
        marginPerOrder: r2(margin),
        marginPct: price > 0 ? r2((margin / price) * 100) : null,
        breakEvenAdSpend: r2(Math.max(0, beforeAds)),
        currency: TEMPLATE_CONFIG.seller_cost_calculator.parse(config).currency,
      };
    }
    case 'vocabulary_assessment':
    case 'practice_quiz': {
      const qs = questionsFor(template, config);
      const answers = (inputs.answers ?? {}) as Record<string, unknown>;
      const graded = qs.map((q) => ({ id: q.id, level: q.level, correct: Number(answers[q.id]) === q.answer, answer: q.options[q.answer], explanation: q.explanation }));
      const byLevel = ([1, 2] as const).map((lv) => {
        const xs = graded.filter((g) => g.level === lv);
        return { level: lv, correct: xs.filter((g) => g.correct).length, total: xs.length };
      });
      const correct = graded.filter((g) => g.correct).length;
      const band = template === 'vocabulary_assessment' ? (byLevel[1]!.total && byLevel[1]!.correct / byLevel[1]!.total >= 0.6 ? 'level 2 words mostly known' : byLevel[0]!.total && byLevel[0]!.correct / byLevel[0]!.total >= 0.6 ? 'level 1 words mostly known' : 'start with level 1 words') : null;
      return { correct, total: qs.length, byLevel, band, graded, note: 'A self-check from the verified lesson bank, not an official EPS-TOPIK score.' };
    }
    case 'readiness_assessment': {
      const c = TEMPLATE_CONFIG.readiness_assessment.parse(config);
      const answers = (inputs.answers ?? {}) as Record<string, unknown>;
      let total = 0;
      const missing: string[] = [];
      for (const q of c.questions) {
        const i = Number(answers[q.id]);
        const o = Number.isInteger(i) ? q.options[i] : undefined;
        if (!o) missing.push(q.id);
        else total += o.points;
      }
      if (missing.length) throw invalid(`answer every question (${missing.join(', ')})`);
      const band = [...c.bands].sort((a, b) => b.min - a.min).find((b) => total >= b.min) ?? c.bands[0]!;
      return { score: total, max: c.questions.reduce((s, q) => s + Math.max(...q.options.map((o) => o.points)), 0), band: band.label, advice: band.advice };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Tool lifecycle (admin)                                              */
/* ------------------------------------------------------------------ */

export const ToolInputSchema = z.object({
  brandId: z.string().uuid(),
  template: z.enum(Object.keys(TEMPLATE_CONFIG) as [ToolTemplate, ...ToolTemplate[]]),
  title: z.string().min(3).max(120),
  config: z.record(z.string(), z.unknown()),
  cta: z.object({ label: z.string().min(1).max(60), url: httpsUrl.nullable().default(null) }).default({ label: 'Learn more', url: null }),
  consent: z.object({ leadCapture: z.boolean().default(false), text: z.string().max(600).default('') }).default({ leadCapture: false, text: '' }),
  experimentId: z.string().uuid().nullable().default(null),
});

function validateConfig(template: ToolTemplate, config: Record<string, unknown>, now: Date): Record<string, unknown> {
  const parsed = TEMPLATE_CONFIG[template].parse(config) as Record<string, unknown>;
  if (template === 'courier_comparison') {
    for (const c of (parsed as z.infer<typeof TEMPLATE_CONFIG.courier_comparison>).couriers) {
      if (new Date(`${c.verifiedAt}T00:00:00Z`).getTime() > now.getTime()) throw invalid(`${c.name}: verifiedAt is in the future`);
    }
  }
  if (template === 'vocabulary_assessment' || template === 'practice_quiz') questionsFor(template, parsed);
  return parsed;
}

export async function createTool(t: Tx, deps: Pick<CoreDeps, 'clock'>, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'creating acquisition tools');
  const p = ToolInputSchema.parse(raw);
  await requireFeature(t, tenantId, 'F4', p.brandId);
  await getBrand(t, p.brandId);
  if (p.consent.leadCapture && p.consent.text.trim().length < 20) throw invalid('lead capture needs the consent text people agree to (what you will send and how to opt out)');
  const now = deps.clock.now();
  const config = validateConfig(p.template, p.config, now);
  const [row] = await t
    .insert(acquisitionTools)
    .values({ tenantId, brandId: p.brandId, template: p.template, publicId: randomBytes(10).toString('hex'), title: p.title, config, methodology: TEMPLATE_INFO[p.template].methodology, cta: p.cta, consent: p.consent, experimentId: p.experimentId, dataUpdatedAt: now, createdBy: actorRef(actor) })
    .returning();
  await audit(t, tenantId, actor, 'growth_warfare.tool.created', { type: 'acquisition_tool', id: row!.id }, { template: p.template, brandId: p.brandId });
  return row!;
}

export async function updateTool(t: Tx, deps: Pick<CoreDeps, 'clock'>, tenantId: string, actor: Actor, id: string, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'editing acquisition tools');
  const p = z.object({ expectedVersion: z.number().int().min(1), title: z.string().min(3).max(120).optional(), config: z.record(z.string(), z.unknown()).optional(), cta: ToolInputSchema.shape.cta.optional(), consent: ToolInputSchema.shape.consent.optional() }).parse(raw);
  const [tool] = await t.select().from(acquisitionTools).where(eq(acquisitionTools.id, id)).for('update');
  if (!tool) throw notFound('tool');
  await requireFeature(t, tenantId, 'F4', tool.brandId);
  if (tool.version !== p.expectedVersion) throw conflict('the tool changed since you loaded it; reload and try again');
  const now = deps.clock.now();
  const config = p.config ? validateConfig(tool.template as ToolTemplate, p.config, now) : tool.config;
  // A published tool goes back to draft when its data or promise changes: a person re-publishes it.
  const changed = Boolean(p.config || p.consent || p.cta);
  await t
    .update(acquisitionTools)
    .set({ title: p.title ?? tool.title, config, cta: p.cta ?? tool.cta, consent: p.consent ?? tool.consent, dataUpdatedAt: p.config ? now : tool.dataUpdatedAt, status: changed && tool.status === 'published' ? 'draft' : tool.status, version: tool.version + 1, updatedAt: now })
    .where(eq(acquisitionTools.id, id));
  await audit(t, tenantId, actor, 'growth_warfare.tool.updated', { type: 'acquisition_tool', id }, { version: tool.version + 1, dataChanged: Boolean(p.config) });
  const [row] = await t.select().from(acquisitionTools).where(eq(acquisitionTools.id, id));
  return row!;
}

/** Publishing makes the tool public: admin + MFA, external operations on, data not stale. */
export async function publishTool(t: Tx, deps: Pick<CoreDeps, 'clock'>, tenantId: string, actor: Actor, id: string, action: 'publish' | 'retire') {
  requireRole(actor, ['owner', 'admin'], `${action === 'publish' ? 'publishing' : 'retiring'} acquisition tools`);
  const [tool] = await t.select().from(acquisitionTools).where(eq(acquisitionTools.id, id)).for('update');
  if (!tool) throw notFound('tool');
  const now = deps.clock.now();
  if (action === 'publish') {
    requireMfa(actor, 'publishing an acquisition tool');
    const s = await requireFeature(t, tenantId, 'F4', tool.brandId);
    if (!s.controls.externalOperations) throw conflict('external operations are off in Growth settings');
    if (tool.template === 'courier_comparison') {
      const old = TEMPLATE_CONFIG.courier_comparison.parse(tool.config).couriers.filter((c) => now.getTime() - new Date(`${c.verifiedAt}T00:00:00Z`).getTime() > 90 * DAY);
      if (old.length) throw conflict(`re-verify the rate cards older than 90 days: ${old.map((c) => c.name).join(', ')}`);
    }
  }
  await t
    .update(acquisitionTools)
    .set({ status: action === 'publish' ? 'published' : 'retired', publishedBy: action === 'publish' ? actorRef(actor) : tool.publishedBy, publishedAt: action === 'publish' ? now : tool.publishedAt, version: tool.version + 1, updatedAt: now })
    .where(eq(acquisitionTools.id, id));
  await audit(t, tenantId, actor, `growth_warfare.tool.${action === 'publish' ? 'published' : 'retired'}`, { type: 'acquisition_tool', id }, {});
  const [row] = await t.select().from(acquisitionTools).where(eq(acquisitionTools.id, id));
  return row!;
}

export async function listTools(t: DbOrTx, brandId?: string) {
  const rows = await t
    .select()
    .from(acquisitionTools)
    .where(brandId ? eq(acquisitionTools.brandId, brandId) : undefined)
    .orderBy(desc(acquisitionTools.createdAt));
  const stats = rows.length
    ? await t.execute<{ tool: string; event_name: string; n: number }>(sql`
        select properties->>'toolId' as tool, event_name, count(*)::int as n from customer_events
        where event_name in ('acquisition_tool_viewed', 'acquisition_tool_completed', 'acquisition_tool_cta_clicked', 'acquisition_tool_lead')
          and properties->>'toolId' in (${sql.join(
            rows.map((r) => sql`${r.id}`),
            sql`, `,
          )})
        group by 1, 2`)
    : { rows: [] };
  return rows.map((r) => ({ ...r, info: TEMPLATE_INFO[r.template as ToolTemplate], stats: Object.fromEntries(stats.rows.filter((s) => s.tool === r.id).map((s) => [s.event_name.replace('acquisition_tool_', ''), s.n])) }));
}

/* ------------------------------------------------------------------ */
/* Public runtime                                                      */
/* ------------------------------------------------------------------ */

async function publishedTool(deps: Pick<CoreDeps, 'db'>, publicId: string) {
  if (!/^[a-z0-9]{12,40}$/.test(publicId)) throw notFound('tool');
  const [tool] = await withSystem(deps.db, 'system:acquisition-tools', (t) => t.select().from(acquisitionTools).where(eq(acquisitionTools.publicId, publicId)));
  if (tool?.status !== 'published') throw notFound('tool');
  return tool;
}

const AnonId = z
  .string()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);

async function variantFor(t: Tx, tool: typeof acquisitionTools.$inferSelect, anonymousId: string | null) {
  if (!tool.experimentId || !anonymousId) return null;
  const [e] = await t.select({ status: experiments.status }).from(experiments).where(eq(experiments.id, tool.experimentId));
  if (e?.status !== 'running') return null;
  try {
    const a = await assign(t, tool.experimentId, anonymousId);
    return a.variant;
  } catch {
    return null;
  }
}

export async function publicView(deps: CoreDeps, publicId: string, anonymousId: string | null) {
  const tool = await publishedTool(deps, publicId);
  return withTenant(deps.db, { tenantId: tool.tenantId, actor: 'system:acquisition-tools' }, async (t) => {
    const [brand] = (await t.execute<{ name: string }>(sql`select name from brands where id = ${tool.brandId}`)).rows;
    const variant = await variantFor(t, tool, anonymousId ? AnonId.parse(anonymousId) : null);
    if (variant && tool.experimentId) await logExposure(t, tool.experimentId, anonymousId!);
    return {
      id: tool.publicId,
      template: tool.template,
      title: tool.title,
      brand: brand?.name ?? null,
      methodology: tool.methodology,
      dataUpdatedAt: tool.dataUpdatedAt?.toISOString() ?? null,
      definition: publicDefinition(tool.template as ToolTemplate, tool.config),
      cta: tool.cta,
      consent: { leadCapture: (tool.consent as { leadCapture?: boolean }).leadCapture === true, text: (tool.consent as { text?: string }).text ?? '' },
      variant,
    };
  });
}

const EventBody = z.object({ anonymousId: AnonId, analyticsConsent: z.boolean().default(false), utm: z.record(z.string(), z.string().max(200)).default({}), referrer: z.string().max(2000).optional() });

async function toolEvent(t: Tx, deps: CoreDeps, tool: typeof acquisitionTools.$inferSelect, event: string, b: z.infer<typeof EventBody>, props: Record<string, unknown>, extra: { email?: string } = {}) {
  const now = deps.clock.now();
  // Without an explicit analytics choice the event is marked unconsented; M02 then does not store it.
  return ingestEventsInTransaction(t, deps, tool.tenantId, `acquisition-tool:${tool.id}`, [
    {
      messageId: `gwt-${sha256Hex(`${tool.id}:${event}:${b.anonymousId}:${now.toISOString()}:${randomBytes(4).toString('hex')}`).slice(0, 40)}`,
      event,
      timestamp: now.toISOString(),
      anonymousId: b.anonymousId,
      ...(extra.email ? { email: extra.email } : {}),
      properties: { toolId: tool.id, template: tool.template, brandId: tool.brandId, ...props },
      context: { consent: { analytics: b.analyticsConsent, marketing: null }, campaign: b.utm, ...(b.referrer ? { page: { referrer: b.referrer } } : {}) },
    },
  ]);
}

export async function publicEvaluate(deps: CoreDeps, publicId: string, raw: unknown) {
  const tool = await publishedTool(deps, publicId);
  const b = EventBody.extend({ inputs: z.record(z.string(), z.unknown()) }).parse(raw);
  const result = evaluateTool(tool.template as ToolTemplate, tool.config, b.inputs);
  await withTenant(deps.db, { tenantId: tool.tenantId, actor: 'system:acquisition-tools' }, async (t) => {
    await toolEvent(t, deps, tool, 'acquisition_tool_completed', b, {});
    const variant = await variantFor(t, tool, b.anonymousId);
    if (variant && tool.experimentId) await logOutcome(t, tool.experimentId, b.anonymousId, 'tool_completed', 1);
  });
  return { result, methodology: tool.methodology, dataUpdatedAt: tool.dataUpdatedAt?.toISOString() ?? null };
}

export async function publicEvent(deps: CoreDeps, publicId: string, raw: unknown) {
  const tool = await publishedTool(deps, publicId);
  const b = EventBody.extend({ event: z.enum(['viewed', 'cta_clicked']) }).parse(raw);
  await withTenant(deps.db, { tenantId: tool.tenantId, actor: 'system:acquisition-tools' }, (t) => toolEvent(t, deps, tool, `acquisition_tool_${b.event}`, b, {}));
  return { ok: true };
}

/** Lead capture: only with the explicit consent box ticked; repeated sign-ups do not duplicate. */
export async function publicLead(deps: CoreDeps, publicId: string, raw: unknown) {
  const tool = await publishedTool(deps, publicId);
  const consent = tool.consent as { leadCapture?: boolean; text?: string };
  if (!consent.leadCapture) throw invalid('this tool does not collect contact details');
  const b = EventBody.extend({ email: z.string().email().max(320), marketingConsent: z.literal(true), consentText: z.string().max(600) }).parse(raw);
  if (normalizeText(b.consentText) !== normalizeText(consent.text ?? '')) throw invalid('the consent text does not match the tool’s current consent text; reload the page');
  return withTenant(deps.db, { tenantId: tool.tenantId, actor: 'system:acquisition-tools' }, async (t) => {
    const now = deps.clock.now();
    const ingest = await toolEvent(t, deps, tool, 'acquisition_tool_lead', { ...b, analyticsConsent: true }, {}, { email: b.email });
    const profileId = ingest.profileIds[0];
    if (!profileId) throw invalid('could not record the sign-up');
    const ev = await admitInternalEvidence(t, tool.tenantId, GW_ACTOR, {
      kind: 'consent',
      owner: 'futuregrow:acquisition-tools',
      uri: `internal:acquisition-tool/${tool.id}/consent/${profileId}/${now.toISOString()}`,
      content: { toolId: tool.id, consentText: consent.text, capturedAt: now.toISOString(), purpose: 'marketing_email' },
      summary: `Marketing e-mail consent given on acquisition tool “${tool.title}”.`,
      confidence: 1,
      license: 'first-party',
      pii: 'pseudonymous',
      lawfulBasis: 'consent',
      permittedUses: ['messaging', 'analytics'],
      now,
    });
    await recordConsent(t, tool.tenantId, GW_ACTOR, { profileId, purpose: 'marketing_email', status: 'granted', lawfulBasis: 'consent', source: `acquisition_tool:${tool.id}`, evidenceId: ev.evidenceId, capturedAt: now.toISOString() });
    const [existing] = await t.execute<{ id: string }>(sql`select id from leads where profile_id = ${profileId} and qualification->>'toolId' = ${tool.id} limit 1`).then((r) => r.rows);
    if (!existing) await t.insert(leads).values({ tenantId: tool.tenantId, profileId, qualification: { source: 'acquisition_tool', toolId: tool.id, brandId: tool.brandId, template: tool.template, consentEvidenceId: ev.evidenceId }, status: 'new' });
    const variant = await variantFor(t, tool, b.anonymousId);
    if (variant && tool.experimentId) await logOutcome(t, tool.experimentId, b.anonymousId, 'lead', 1);
    return { ok: true, duplicate: Boolean(existing) };
  });
}

/* ------------------------------------------------------------------ */
/* AI search visibility                                                */
/* ------------------------------------------------------------------ */

export const VisibilityImportSchema = z.object({
  brandId: z.string().uuid(),
  engine: z.string().min(2).max(60),
  method: z.literal('manual_import').default('manual_import'),
  sourceNote: z.string().min(5).max(500),
  observations: z
    .array(
      z.object({
        query: z.string().min(2).max(300),
        observedAt: z.string().datetime({ offset: true }),
        brandMentioned: z.boolean(),
        brandCited: z.boolean().default(false),
        competitorsMentioned: z.array(z.string().min(1).max(80)).max(20).default([]),
        citedSources: z.array(z.string().min(3).max(300)).max(30).default([]),
        recommendedProducts: z.array(z.string().min(1).max(120)).max(20).default([]),
      }),
    )
    .min(1)
    .max(500),
});

/** Auditable manual import: the whole batch is admitted as evidence first, then each row cites it. */
export async function importVisibility(t: Tx, deps: Pick<CoreDeps, 'clock'>, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator', 'analyst'], 'importing search visibility observations');
  const p = VisibilityImportSchema.parse(raw);
  await requireFeature(t, tenantId, 'F4', p.brandId);
  await getBrand(t, p.brandId);
  const now = deps.clock.now();
  if (p.observations.some((o) => new Date(o.observedAt) > now)) throw invalid('an observation is dated in the future');
  const ev = await admitInternalEvidence(
    t,
    tenantId,
    { ...actor },
    {
      kind: 'observation',
      owner: `${actor.type}:${actor.id}`,
      uri: `manual-import:search-visibility/${encodeURIComponent(p.engine)}/${now.toISOString()}`,
      content: { engine: p.engine, sourceNote: p.sourceNote, observations: p.observations },
      summary: `${p.observations.length} AI/search answer observation(s) for ${p.engine}, imported by hand (${clipText(p.sourceNote, 120)}).`,
      confidence: 0.8,
      license: 'own observation',
      permittedUses: ['analytics', 'competitive_analysis', 'creative_generation'],
      freshnessSlaHours: 24 * 60,
      now,
    },
  );
  let inserted = 0;
  for (const o of p.observations) {
    const r = await t
      .insert(searchVisibilityObservations)
      .values({
        tenantId,
        brandId: p.brandId,
        engine: p.engine,
        query: o.query,
        observedAt: new Date(o.observedAt),
        brandMentioned: o.brandMentioned,
        brandCited: o.brandCited,
        competitorsMentioned: o.competitorsMentioned,
        citedSources: o.citedSources,
        recommendedProducts: o.recommendedProducts,
        method: 'manual_import',
        evidenceId: ev.evidenceId,
        createdBy: actorRef(actor),
      })
      .onConflictDoNothing()
      .returning({ id: searchVisibilityObservations.id });
    inserted += r.length;
  }
  await audit(t, tenantId, actor, 'growth_warfare.visibility.imported', { type: 'evidence', id: ev.evidenceId }, { engine: p.engine, rows: p.observations.length, inserted });
  return { evidenceId: ev.evidenceId, inserted, duplicates: p.observations.length - inserted };
}

const TOOL_HINTS: { re: RegExp; template: ToolTemplate }[] = [
  { re: /courier|delivery (charge|fee|cost)|shipping (cost|rate)/i, template: 'courier_comparison' },
  { re: /\bcod\b|cash on delivery|reconcil/i, template: 'cod_reconciliation' },
  { re: /profit|margin|cost calculat|pricing calculat/i, template: 'seller_cost_calculator' },
  { re: /vocab|word|শব্দ/i, template: 'vocabulary_assessment' },
  { re: /quiz|practice|test|exam|পরীক্ষা/i, template: 'practice_quiz' },
  { re: /ready|readiness|prepare|start learning/i, template: 'readiness_assessment' },
];

const tally = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

/** Coverage, gaps and evidence-backed recommendations; says plainly when there is no data. */
export async function visibilityReport(t: DbOrTx, brandId: string, now: Date) {
  const rows = await t.select().from(searchVisibilityObservations).where(eq(searchVisibilityObservations.brandId, brandId)).orderBy(desc(searchVisibilityObservations.observedAt)).limit(2000);
  const b = await getBrand(t, brandId);
  const { config } = await getBrandConfig(t, brandId);
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const k = `${r.engine}\u0000${normalizeText(r.query)}`;
    if (!latest.has(k)) latest.set(k, r);
  }
  const current = [...latest.values()];
  const engines = [...new Set(current.map((r) => r.engine))];
  const coverage = {
    trackedQueries: new Set(current.map((r) => normalizeText(r.query))).size,
    engines,
    lastObservedAt: rows[0]?.observedAt.toISOString() ?? null,
    stale: rows[0] ? now.getTime() - rows[0].observedAt.getTime() > 30 * DAY : null,
    mentionRate: Object.fromEntries(
      engines.map((e) => {
        const xs = current.filter((r) => r.engine === e);
        return [e, { mentioned: xs.filter((r) => r.brandMentioned).length, cited: xs.filter((r) => r.brandCited).length, total: xs.length }];
      }),
    ),
    competitorMentions: tally(current.flatMap((r) => r.competitorsMentioned)),
    citedDomains: tally(
      current.flatMap((r) =>
        r.citedSources.map((src) => {
          try {
            return new URL(src).host;
          } catch {
            return src;
          }
        }),
      ),
    ).slice(0, 15),
  };
  const claimIds = b.approvedClaims.map((c) => c.id);
  const approved = claimIds.length
    ? await t
        .select()
        .from(claims)
        .where(and(inArray(claims.id, claimIds), eq(claims.status, 'approved')))
    : [];
  const usable = approved.filter((c) => !c.expiresAt || c.expiresAt > now);
  const answerFor = (q: string) => {
    const words = new Set(
      normalizeText(q)
        .split(' ')
        .filter((w) => w.length > 3),
    );
    return usable
      .map((c) => ({
        c,
        s: normalizeText(c.text)
          .split(' ')
          .filter((w) => words.has(w)).length,
      }))
      .sort((a, b) => b.s - a.s)
      .filter((x) => x.s > 0)
      .slice(0, 2)
      .map((x) => ({ claimId: x.c.id, text: x.c.text }));
  };
  const gaps = current
    .filter((r) => !r.brandMentioned || !r.brandCited)
    .map((r) => ({ query: r.query, engine: r.engine, observedAt: r.observedAt.toISOString(), evidenceId: r.evidenceId, gap: r.brandMentioned ? 'mentioned_not_cited' : r.competitorsMentioned.length ? 'competitor_visible' : 'brand_absent', competitors: r.competitorsMentioned }));
  // Search Console questions where the brand's page is visible but rarely clicked (FAQ candidates).
  const sc = (
    await t.execute<{ query: string; impressions: number; clicks: number; position: number | null; evidence_id: string }>(sql`
      select query, sum(impressions)::int as impressions, sum(clicks)::int as clicks, sum(position * impressions) / nullif(sum(impressions), 0) as position, min(evidence_id::text) as evidence_id
      from keyword_metrics where period_end = (select max(period_end) from keyword_metrics) group by query having sum(impressions) >= 50 order by 2 desc limit 300`)
  ).rows.filter((r) => /^(how|what|why|which|can|is|does|where|when)\b|\?$|কিভাবে|কী|কেন/iu.test(r.query.trim()) && (!config.keywords.length || config.keywords.some((k) => normalizeText(r.query).includes(normalizeText(k)))));
  const recommendations = [
    ...gaps.slice(0, 40).map((g) => {
      const answer = answerFor(g.query);
      const tool = TOOL_HINTS.find((h) => h.re.test(g.query));
      return {
        query: g.query,
        basis: { engine: g.engine, observedAt: g.observedAt, gap: g.gap, evidenceId: g.evidenceId },
        contentImprovement: answer.length ? `Answer “${g.query}” on the brand site in plain words, using: ${answer.map((a) => a.text).join(' / ')}` : `Write an approved claim that answers “${g.query}” before publishing content for it.`,
        faq: answer.length ? { question: g.query, answer: answer.map((a) => a.text).join(' '), claimIds: answer.map((a) => a.claimId) } : null,
        comparisonPage: g.competitors.length ? { competitors: g.competitors, next: 'Prepare a factual comparison page through Competitor Conquest (F2) from verified observations.' } : null,
        structuredData: answer.length ? { type: 'FAQPage', jsonLd: { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: g.query, acceptedAnswer: { '@type': 'Answer', text: answer.map((a) => a.text).join(' ') } }] } } : null,
        toolIdea: tool ? { template: tool.template, title: TEMPLATE_INFO[tool.template].title } : null,
        measurement: { plan: `Re-check “${g.query}” on ${g.engine} 14 and 28 days after publishing; record mention and citation by manual import.`, metric: 'brand mentioned / cited in the observed answer', guarantee: 'none — AI answers change and no ranking is promised' },
      };
    }),
    ...sc.slice(0, 20).map((r) => {
      const answer = answerFor(r.query);
      return {
        query: r.query,
        basis: { engine: 'google_search_console', observedAt: null, gap: 'low_ctr_question', evidenceId: r.evidence_id, impressions: r.impressions, clicks: r.clicks, position: r.position === null ? null : Math.round(r.position * 10) / 10 },
        contentImprovement: `The site shows for “${r.query}” (${r.impressions} impressions, ${r.clicks} clicks); answer it directly near the top of the ranking page.`,
        faq: answer.length ? { question: r.query, answer: answer.map((a) => a.text).join(' '), claimIds: answer.map((a) => a.claimId) } : null,
        comparisonPage: null,
        structuredData: answer.length ? { type: 'FAQPage', jsonLd: { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: r.query, acceptedAnswer: { '@type': 'Answer', text: answer.map((a) => a.text).join(' ') } }] } } : null,
        toolIdea: TOOL_HINTS.find((h) => h.re.test(r.query)) ? { template: TOOL_HINTS.find((h) => h.re.test(r.query))!.template } : null,
        measurement: { plan: 'Compare clicks and CTR for this query over the next two complete Search Console periods (observational).', metric: 'clicks, CTR', guarantee: 'none' },
      };
    }),
  ];
  const [kw] = await t.select({ n: sql<number>`count(*)::int` }).from(keywordMetrics);
  const missing = [
    ...(rows.length ? [] : ['No AI/search answer observations yet. Import observations by hand (engine, question, date, whether the brand was mentioned or cited).']),
    ...((kw?.n ?? 0) ? [] : ['No Search Console data. Connect Search Console (Channels › Search Console) or upload keyword metrics.']),
    'No approved AI-visibility provider API is configured; consumer AI assistants are never automated.',
  ];
  return { brand: b.brand.name, coverage, gaps, recommendations, missing, providerStatus: 'manual_import_only' as const, note: 'Observations describe what one answer showed on one date. They are not rankings and nothing here guarantees AI visibility.' };
}
