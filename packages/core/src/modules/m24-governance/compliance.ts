import { complianceItems, type DbOrTx, evidenceRecords, type Tx } from '@futuregrow/db';
import { conflict, invalid } from '@futuregrow/observability';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef } from '../../deps.js';
import { audit, requireMfa, requireRole } from '../../util.js';

/**
 * Legal, policy and licensing readiness (P2-15). Each item is a question counsel or the owner must
 * answer for this organization; an approval records who reviewed what document (by content hash
 * and admitted evidence) and when it expires. `gates` lists what FUTUREGROW refuses until the item
 * is approved, and `enforcedBy` says honestly where that happens in code. Automated tests show
 * that the gates work; they are not a legal review.
 */

export interface ComplianceDefinition {
  key: string;
  title: string;
  area: 'data_protection' | 'marketing' | 'ai_media' | 'advertising' | 'creators' | 'licensing' | 'payments' | 'security_research';
  question: string;
  gates: string[];
  enforcedBy: string[];
  validMonths: number;
}

export const COMPLIANCE_DEFINITIONS: readonly ComplianceDefinition[] = [
  {
    key: 'provider_dpas',
    title: 'Data processing agreements with providers',
    area: 'data_protection',
    question: 'Are DPAs (or equivalent terms) in place with every processor that receives personal data (Resend, PostHog, Chatwoot, model providers)?',
    gates: ['documentation for the processor register'],
    enforcedBy: ['M02 consent gates every forwarding; PostHog forwarding is off until enabled'],
    validMonths: 12,
  },
  {
    key: 'market_rule_packs',
    title: 'Market-specific rule packs',
    area: 'marketing',
    question: 'Has counsel approved the jurisdiction rule packs for each market and review domain the organization operates in?',
    gates: ['public, messaging, advertising and pricing actions in markets without an approved pack'],
    enforcedBy: ['M24 jurisdiction rule packs (R-JURISDICTION) require legal approval per action'],
    validMonths: 12,
  },
  {
    key: 'marketing_consent',
    title: 'Marketing consent and email rules',
    area: 'marketing',
    question: 'Do the consent wording, lawful bases, sender identity, postal address and unsubscribe flow meet CAN-SPAM, GDPR/ePrivacy and local rules?',
    gates: ['lifecycle email journeys'],
    enforcedBy: ['M20 consent and suppression checks, RFC 8058 unsubscribe, four-eyes template approval'],
    validMonths: 12,
  },
  {
    key: 'ai_generated_media',
    title: 'AI-generated media rights and disclosure',
    area: 'ai_media',
    question: 'May the organization use and publish AI-generated images and videos commercially, and is the disclosure wording adequate?',
    gates: ['AI image generation'],
    enforcedBy: ['image models need registry approval plus an approved licence record; AI assets carry the AI-generated disclosure'],
    validMonths: 12,
  },
  { key: 'synthetic_personas', title: 'Synthetic persona disclosure', area: 'ai_media', question: 'Are virtual characters disclosed as AI in every market they appear in?', gates: ['persona content'], enforcedBy: ['M15 persona approval and mandatory disclosure overlay'], validMonths: 12 },
  {
    key: 'advertising_restrictions',
    title: 'Advertising restrictions',
    area: 'advertising',
    question: 'Which categories (special ad categories, regulated products, minors) and claims are restricted for paid campaigns?',
    gates: ['paid campaign creation (also disabled by B-026)'],
    enforcedBy: ['campaign drafts refuse special ad categories and minors; copy lint against approved claims'],
    validMonths: 12,
  },
  { key: 'creator_disclosure', title: 'Creator and affiliate disclosure', area: 'creators', question: 'Do creator contracts and posts meet the FTC Endorsement Guides and local equivalents?', gates: ['creator content approval'], enforcedBy: ['M22 conspicuous-disclosure check'], validMonths: 12 },
  {
    key: 'remotion_licence',
    title: 'Remotion licence eligibility',
    area: 'licensing',
    question: 'Is the organization eligible for the Remotion free licence (≤3 people) or does it hold a company licence?',
    gates: ['video rendering'],
    enforcedBy: ['M14 refuses renders until the Remotion licence is recorded (B-014)'],
    validMonths: 12,
  },
  {
    key: 'stock_media_licence',
    title: 'Stock media commercial licence',
    area: 'licensing',
    question: 'Do the stock providers’ licences (e.g. Pexels License) allow the intended commercial uses, including ads?',
    gates: ['stock imports'],
    enforcedBy: ['stock imports need an approved stock_media licence record'],
    validMonths: 12,
  },
  {
    key: 'model_commercial_use',
    title: 'Generative model commercial-use licences',
    area: 'licensing',
    question: 'Do the terms of every generative model allow commercial use of outputs without training on customer data?',
    gates: ['AI images and text'],
    enforcedBy: ['model registry approval (commercial use allowed, no training on customer data)'],
    validMonths: 12,
  },
  { key: 'voice_audio_rights', title: 'Video, voice and audio rights', area: 'licensing', question: 'Are music, voice and likeness rights cleared for every published video?', gates: ['publishing assets with music, voice or likeness'], enforcedBy: ['M14 eligibility needs music/voice/likeness rights'], validMonths: 12 },
  { key: 'retention_deletion', title: 'Data retention and deletion', area: 'data_protection', question: 'Are the retention periods and the deletion (DSAR) process approved?', gates: ['documentation of retention policies'], enforcedBy: ['M02 retention sweep and DSAR deletion'], validMonths: 12 },
  {
    key: 'creator_payouts',
    title: 'Payment and payout restrictions',
    area: 'payments',
    question: 'Are creator payouts, tax forms, KYC and payout restrictions per country reviewed, with a merchant agreement in place?',
    gates: ['creator payouts'],
    enforcedBy: ['payout readiness check legal_approval (also disabled by B-015)'],
    validMonths: 12,
  },
  {
    key: 'research_sandbox',
    title: 'Authorized research and reverse engineering',
    area: 'security_research',
    question: 'Is analysing the allowlisted targets lawful (ownership, licence or written authorization) and is the isolated runner approved?',
    gates: ['research jobs'],
    enforcedBy: ['research jobs need this approval, an allowlisted target and an isolated runner (B-012)'],
    validMonths: 6,
  },
];

const byKey = new Map(COMPLIANCE_DEFINITIONS.map((d) => [d.key, d]));

export const ComplianceReviewSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('in_review'), note: z.string().trim().max(2000).default('') }).strict(),
  z
    .object({
      status: z.literal('approved'),
      reviewerName: z.string().trim().min(3).max(200),
      reviewerRole: z.enum(['external_counsel', 'in_house_counsel', 'owner', 'licensor_confirmation']),
      reviewedAt: z.string().date(),
      documentRef: z.string().trim().min(3).max(500),
      evidenceId: z.string().uuid(),
      contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
      note: z.string().trim().max(2000).default(''),
    })
    .strict(),
  z.object({ status: z.literal('rejected'), note: z.string().trim().min(5).max(2000) }).strict(),
]);

export async function recordComplianceReview(t: Tx, tenantId: string, actor: Actor, key: string, raw: unknown, now: Date) {
  const def = byKey.get(key);
  if (!def) throw invalid(`unknown compliance item ${key}`);
  requireRole(actor, ['owner', 'legal_approver'], 'recording a legal review');
  const input = ComplianceReviewSchema.parse(raw);
  if (input.status === 'approved') {
    requireMfa(actor, 'approving a legal review');
    const [ev] = await t.select().from(evidenceRecords).where(eq(evidenceRecords.id, input.evidenceId));
    if (!ev || ev.status !== 'admitted') throw invalid('the review document must be admitted evidence');
    if (input.reviewerRole === 'owner' && ['creator_payouts', 'research_sandbox', 'market_rule_packs'].includes(key)) throw conflict(`${def.title} needs counsel, not only the owner`);
  }
  const reviewedAt = input.status === 'approved' ? new Date(`${input.reviewedAt}T00:00:00Z`) : null;
  const expiresAt = reviewedAt ? new Date(Date.UTC(reviewedAt.getUTCFullYear(), reviewedAt.getUTCMonth() + def.validMonths, reviewedAt.getUTCDate())) : null;
  if (expiresAt && expiresAt <= now) throw invalid('this review is already past its validity period; review again');
  const values = {
    status: input.status,
    reviewerName: input.status === 'approved' ? input.reviewerName : null,
    reviewerRole: input.status === 'approved' ? input.reviewerRole : null,
    reviewedAt,
    documentRef: input.status === 'approved' ? input.documentRef : null,
    evidenceId: input.status === 'approved' ? input.evidenceId : null,
    contentSha256: input.status === 'approved' ? input.contentSha256 : null,
    note: input.note || null,
    expiresAt,
    decidedBy: actorRef(actor),
    decidedAt: now,
    updatedAt: now,
  };
  const [row] = await t
    .insert(complianceItems)
    .values({ tenantId, key, ...values })
    .onConflictDoUpdate({ target: [complianceItems.tenantId, complianceItems.key], set: values })
    .returning();
  await audit(t, tenantId, actor, `compliance.${input.status}`, { type: 'compliance_item', id: row!.id }, { key, reviewerRole: values.reviewerRole, documentRef: values.documentRef, contentSha256: values.contentSha256, expiresAt: expiresAt?.toISOString() ?? null });
  return row!;
}

/** True only for an approved, unexpired review of `key`. */
export async function isComplianceApproved(t: DbOrTx, key: string, now: Date): Promise<boolean> {
  const [row] = await t
    .select()
    .from(complianceItems)
    .where(and(eq(complianceItems.key, key), eq(complianceItems.status, 'approved')));
  return Boolean(row && (!row.expiresAt || row.expiresAt > now));
}

/** The checklist with each item's state (expired approvals read as expired) and what it gates. */
export async function complianceChecklist(t: DbOrTx, now: Date) {
  const rows = await t.select().from(complianceItems);
  const items = COMPLIANCE_DEFINITIONS.map((d) => {
    const r = rows.find((x) => x.key === d.key);
    const expired = Boolean(r?.status === 'approved' && r.expiresAt && r.expiresAt <= now);
    return {
      ...d,
      status: expired ? 'expired' : (r?.status ?? 'not_started'),
      reviewerName: r?.reviewerName ?? null,
      reviewerRole: r?.reviewerRole ?? null,
      reviewedAt: r?.reviewedAt?.toISOString() ?? null,
      documentRef: r?.documentRef ?? null,
      evidenceId: r?.evidenceId ?? null,
      expiresAt: r?.expiresAt?.toISOString() ?? null,
      note: r?.note ?? null,
    };
  });
  return { items, approved: items.filter((i) => i.status === 'approved').length, total: items.length, note: 'Approvals record a human legal review. FUTUREGROW’s automated tests show that gates work; they are not legal advice or a substitute for counsel.' };
}
