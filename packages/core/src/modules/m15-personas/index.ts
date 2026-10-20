import { artifactLicenses, type DbOrTx, evidenceRecords, protectedIdentities, syntheticPersonas, type Tx } from '@futuregrow/db';
import { conflict, invalid, notFound } from '@futuregrow/observability';
import { desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef } from '../../deps.js';
import { audit, normalizeText, record, requireMfa, requireRole } from '../../util.js';

const DISCLOSURE_WORDS = /\b(ai|a\.i\.|artificial|virtual|synthetic|digital (character|creator|persona)|computer[- ]generated|not a real person)\b/i;

/** First-person experience claims a synthetic character must never make (FTC fake testimonial rules). */
const FAKE_EXPERIENCE = [
  /\bi(?:'ve| have)? (tried|tested|used|been using|bought|purchased|switched to)\b/i,
  /\bmy (results|experience|skin|body|weight|savings|business grew)\b/i,
  /\bas a (real |long[- ]time |happy |loyal )?(customer|user|mom|dad|doctor|nurse|expert)\b/i,
  /\b(changed my life|i can'?t live without|i swear by|honest review|unsponsored)\b/i,
];

export function personaContentCheck(text: string): { passed: boolean; findings: string[] } {
  const findings = FAKE_EXPERIENCE.filter((re) => re.test(text)).map((re) => re.source);
  return { passed: findings.length === 0, findings };
}

export async function addProtectedIdentity(tx: Tx, tenantId: string, actor: Actor, input: { name: string; reason: string }) {
  requireRole(actor, ['owner', 'admin', 'legal_approver'], 'maintaining protected identities');
  const [row] = await tx
    .insert(protectedIdentities)
    .values({ tenantId, name: input.name, normalizedName: normalizeText(input.name), reason: input.reason })
    .onConflictDoNothing()
    .returning();
  await audit(tx, tenantId, actor, 'persona.protected_identity.added', { type: 'protected_identity', id: row?.id ?? 'existing' }, { name: input.name });
  return row ?? null;
}

export const PersonaSchema = z.object({
  name: z.string().min(2).max(100),
  personaBible: z.object({
    backstory: z.string().min(20).max(4000),
    voiceTone: z.string().min(3).max(500),
    values: z.array(z.string().max(200)).max(10).default([]),
    topicsAllowed: z.array(z.string().max(200)).max(30).default([]),
    topicsForbidden: z.array(z.string().max(200)).max(30).default([]),
  }),
  visualIdentity: z.object({ referenceAssetIds: z.array(z.string().uuid()).max(20).default([]), styleNotes: z.string().max(1000).default('') }),
  voiceIdentity: z.object({ voiceArtifactLicenseId: z.string().uuid().nullable().default(null), notes: z.string().max(1000).default('') }),
  disclosureCopy: z.string().min(10).max(300),
  platformDisclosures: z.record(z.string(), z.unknown()).default({}),
  contentRules: z.object({ noTestimonials: z.literal(true).default(true), noHumanExperienceClaims: z.literal(true).default(true), extra: z.array(z.string().max(300)).max(20).default([]) }).default({ noTestimonials: true, noHumanExperienceClaims: true, extra: [] }),
  likeness: z.discriminatedUnion('origin', [z.object({ origin: z.literal('original_synthetic'), attestation: z.string().min(20).max(2000) }), z.object({ origin: z.literal('licensed_likeness'), consentEvidenceId: z.string().uuid(), rightsHolder: z.string().min(2).max(200), attestation: z.string().min(20).max(2000) })]),
  childPersona: z.boolean().default(false),
});

export async function createPersona(tx: Tx, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'creating synthetic personas');
  const p = PersonaSchema.parse(raw);
  const problems: string[] = [];
  if (!DISCLOSURE_WORDS.test(p.disclosureCopy)) problems.push('disclosure copy must clearly say the character is AI-generated/virtual');
  if (!/fictional|virtual|ai|synthetic/i.test(p.personaBible.backstory)) problems.push('persona bible must state that the character is fictional/synthetic');
  const protectedRows = await tx.select().from(protectedIdentities);
  const norm = normalizeText(p.name);
  const hit = protectedRows.find((r) => norm === r.normalizedName || norm.includes(r.normalizedName) || r.normalizedName.includes(norm));
  if (hit) problems.push(`name matches protected identity "${hit.name}" (impersonation risk)`);
  if (p.likeness.origin === 'licensed_likeness') {
    const [ev] = await tx.select().from(evidenceRecords).where(eq(evidenceRecords.id, p.likeness.consentEvidenceId));
    if (!ev || ev.status !== 'admitted' || !['consent', 'contract'].includes(ev.kind)) problems.push('licensed likeness requires admitted consent/contract evidence');
  }
  if (p.voiceIdentity.voiceArtifactLicenseId) {
    const [a] = await tx.select().from(artifactLicenses).where(eq(artifactLicenses.id, p.voiceIdentity.voiceArtifactLicenseId));
    if (!a || a.artifactType !== 'voice' || !a.approvedForProduction) problems.push('voice artifact must be an approved voice licence');
  }
  const blocked = problems.length > 0 || p.childPersona;
  const [row] = await tx
    .insert(syntheticPersonas)
    .values({
      tenantId,
      name: p.name,
      personaBible: p.personaBible,
      visualIdentity: p.visualIdentity,
      voiceIdentity: p.voiceIdentity,
      disclosureCopy: p.disclosureCopy,
      platformDisclosures: { tiktok: { is_aigc: true }, youtube: { containsSyntheticMedia: true }, meta: { aiInfoLabel: true }, ...p.platformDisclosures },
      contentRules: p.contentRules,
      likenessAttestation: { ...p.likeness, attestedBy: actorRef(actor), attestedAt: new Date().toISOString() },
      impersonationCheck: { checkedAgainst: protectedRows.length, problems },
      childPersona: p.childPersona,
      status: blocked ? 'blocked' : 'draft',
      createdBy: actorRef(actor),
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict('a persona with this name already exists');
  await audit(tx, tenantId, actor, 'persona.persona.created', { type: 'synthetic_persona', id: row.id }, { status: row.status, problems, childPersona: p.childPersona });
  return row;
}

/** Approval by legal (or the owner). Child personas need legal sign-off and stay blocked otherwise. */
export async function approvePersona(tx: Tx, tenantId: string, actor: Actor, id: string) {
  requireMfa(actor, 'approving synthetic personas');
  const [p] = await tx.select().from(syntheticPersonas).where(eq(syntheticPersonas.id, id)).for('update');
  if (!p) throw notFound('persona');
  requireRole(actor, p.childPersona ? ['legal_approver'] : ['legal_approver', 'owner'], 'approving synthetic personas');
  const problems = (p.impersonationCheck as { problems?: string[] }).problems ?? [];
  if (problems.length) throw invalid(`persona has unresolved problems: ${problems.join('; ')}`);
  if (p.status === 'approved') throw conflict('persona already approved');
  const [row] = await tx
    .update(syntheticPersonas)
    .set({ status: 'approved', approvedBy: actorRef(actor), approvedAt: new Date() })
    .where(eq(syntheticPersonas.id, id))
    .returning();
  await record(tx, tenantId, actor, 'persona.persona.approved', { type: 'synthetic_persona', id }, {});
  return row!;
}

export async function suspendPersona(tx: Tx, tenantId: string, actor: Actor, id: string, reason: string) {
  requireRole(actor, ['owner', 'admin', 'legal_approver', 'approver'], 'suspending personas');
  const [row] = await tx.update(syntheticPersonas).set({ status: 'suspended' }).where(eq(syntheticPersonas.id, id)).returning();
  if (!row) throw notFound('persona');
  await audit(tx, tenantId, actor, 'persona.persona.suspended', { type: 'synthetic_persona', id }, { reason });
  return row;
}

export async function listPersonas(tx: DbOrTx) {
  return tx.select().from(syntheticPersonas).orderBy(desc(syntheticPersonas.createdAt));
}

export async function personasByIds(tx: DbOrTx, ids: string[]) {
  return ids.length ? tx.select().from(syntheticPersonas).where(inArray(syntheticPersonas.id, ids)) : [];
}
