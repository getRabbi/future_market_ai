import { injectionSignals } from '@futuregrow/agent-kernel';
import { brandRules, claims, type DbOrTx, evidenceRecords, kgEntities, kgRelations, knowledgeChunks, knowledgeDocuments, type Tx } from '@futuregrow/db';
import { conflict, invalid, notFound, sha256Hex } from '@futuregrow/observability';
import { tenantKey } from '@futuregrow/storage';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { audit, normalizeText, record, requireRole } from '../../util.js';
import { effectiveFreshness } from '../m23-execution/facts.js';
import { raiseAlert } from '../m24-governance/index.js';

export interface Embedder {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

async function requireTrustedEvidence(tx: Tx, ids: string[], now: Date) {
  if (!ids.length) throw invalid('at least one evidence id is required');
  const rows = await tx.select().from(evidenceRecords).where(inArray(evidenceRecords.id, ids));
  if (rows.length !== new Set(ids).size) throw invalid('evidence not found');
  const bad = rows.filter((e) => e.status !== 'admitted' || effectiveFreshness(e, now) === 'stale');
  if (bad.length) throw invalid(`evidence not admitted/current: ${bad.map((b) => b.id).join(', ')}`);
  return rows;
}

/* ------------------------------------------------------------------ */
/* Entities (versioned facts)                                          */
/* ------------------------------------------------------------------ */

export const EntityInputSchema = z.object({
  kind: z.enum(['product', 'feature', 'plan', 'price', 'policy', 'faq', 'brand_guide', 'release', 'integration', 'audience']),
  key: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9][a-z0-9._:-]*$/),
  name: z.string().min(1).max(300),
  attributes: z.record(z.string(), z.unknown()).default({}),
  evidenceId: z.string().uuid(),
  validTo: z.string().datetime({ offset: true }).nullable().default(null),
});

export async function upsertEntity(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  const input = EntityInputSchema.parse(raw);
  const now = deps.clock.now();
  const [ev] = await requireTrustedEvidence(tx, [input.evidenceId], now);
  const [current] = await tx
    .select()
    .from(kgEntities)
    .where(and(eq(kgEntities.kind, input.kind), eq(kgEntities.key, input.key), inArray(kgEntities.status, ['active', 'conflict'])))
    .orderBy(desc(kgEntities.version))
    .limit(1);
  let status: 'active' | 'conflict' = 'active';
  if (current) {
    const [curEv] = await tx.select().from(evidenceRecords).where(eq(evidenceRecords.id, current.evidenceId));
    const newObserved = (ev!.observedAt ?? ev!.retrievedAt).getTime();
    const curObserved = curEv ? (curEv.observedAt ?? curEv.retrievedAt).getTime() : 0;
    const differs = JSON.stringify(current.attributes) !== JSON.stringify(input.attributes) || current.name !== input.name;
    // An older or equally-old source contradicting the current fact is a conflict, not an update.
    if (differs && newObserved <= curObserved && curEv?.sourceUriOrObjectId !== ev!.sourceUriOrObjectId) status = 'conflict';
  }
  if (current && status === 'active') {
    await tx.update(kgEntities).set({ status: 'superseded', validTo: now }).where(eq(kgEntities.id, current.id));
  }
  if (current && status === 'conflict') {
    await tx.update(kgEntities).set({ status: 'conflict' }).where(eq(kgEntities.id, current.id));
    await raiseAlert(tx, tenantId, { kind: 'knowledge.conflict', severity: 'warning', message: `conflicting facts for ${input.kind}:${input.key}`, refs: { key: input.key }, dedupKey: `kg-conflict:${input.kind}:${input.key}` });
  }
  const [row] = await tx
    .insert(kgEntities)
    .values({
      tenantId,
      kind: input.kind,
      key: input.key,
      name: input.name,
      attributes: input.attributes,
      version: (current?.version ?? 0) + 1,
      status,
      validFrom: now,
      validTo: input.validTo ? new Date(input.validTo) : null,
      evidenceId: input.evidenceId,
      createdBy: actorRef(actor),
    })
    .returning();
  await audit(tx, tenantId, actor, 'knowledge.entity.upserted', { type: 'kg_entity', id: row!.id }, { kind: input.kind, key: input.key, version: row!.version, status });
  return row!;
}

export async function resolveConflict(tx: Tx, tenantId: string, actor: Actor, keepEntityId: string) {
  requireRole(actor, ['owner', 'admin', 'approver'], 'resolving knowledge conflicts');
  const [keep] = await tx.select().from(kgEntities).where(eq(kgEntities.id, keepEntityId));
  if (!keep) throw notFound('entity');
  await tx
    .update(kgEntities)
    .set({ status: 'superseded' })
    .where(and(eq(kgEntities.kind, keep.kind), eq(kgEntities.key, keep.key), eq(kgEntities.status, 'conflict'), sql`${kgEntities.id} <> ${keep.id}`));
  const [row] = await tx.update(kgEntities).set({ status: 'active' }).where(eq(kgEntities.id, keep.id)).returning();
  await audit(tx, tenantId, actor, 'knowledge.conflict.resolved', { type: 'kg_entity', id: keep.id }, {});
  return row!;
}

export async function relate(tx: Tx, tenantId: string, actor: Actor, input: { fromEntityId: string; relation: string; toEntityId: string; evidenceId: string }) {
  if (!/^[a-z_]{2,40}$/.test(input.relation)) throw invalid('relation must be snake_case');
  const [row] = await tx
    .insert(kgRelations)
    .values({ tenantId, ...input })
    .onConflictDoNothing()
    .returning();
  await audit(tx, tenantId, actor, 'knowledge.relation.created', { type: 'kg_relation', id: row?.id ?? 'existing' }, input);
  return row ?? null;
}

export async function activeFacts(tx: DbOrTx, kinds?: string[]) {
  return tx
    .select()
    .from(kgEntities)
    .where(and(eq(kgEntities.status, 'active'), ...(kinds?.length ? [inArray(kgEntities.kind, kinds)] : [])))
    .orderBy(kgEntities.kind, kgEntities.key);
}

/* ------------------------------------------------------------------ */
/* Claims registry                                                     */
/* ------------------------------------------------------------------ */

const REGULATED_TYPES = new Set(['health', 'financial', 'environmental', 'comparative', 'testimonial']);

export const ClaimInputSchema = z.object({
  text: z.string().min(3).max(1000),
  claimType: z.enum(['product_capability', 'price', 'comparative', 'statistic', 'testimonial', 'health', 'financial', 'environmental', 'availability', 'other']),
  evidenceIds: z.array(z.string().uuid()).min(1),
  entityIds: z.array(z.string().uuid()).default([]),
  jurisdictions: z.array(z.string().min(2)).default([]),
  expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
});

export async function proposeClaim(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  const input = ClaimInputSchema.parse(raw);
  await requireTrustedEvidence(tx, input.evidenceIds, deps.clock.now());
  if (input.claimType === 'testimonial') {
    // Testimonials must come from genuine, attributable customer evidence (FTC rules).
    const ev = await tx.select().from(evidenceRecords).where(inArray(evidenceRecords.id, input.evidenceIds));
    if (!ev.some((e) => e.kind === 'consent' || e.lawfulBasisOrConsentId)) throw invalid('testimonial claims need evidence of a genuine customer statement with consent to use it');
  }
  if (input.entityIds.length) {
    const ents = await tx.select().from(kgEntities).where(inArray(kgEntities.id, input.entityIds));
    if (ents.some((e) => e.status !== 'active')) throw invalid('claims may only reference active facts');
  }
  const [row] = await tx
    .insert(claims)
    .values({
      tenantId,
      text: input.text,
      normalizedText: normalizeText(input.text),
      claimType: input.claimType,
      regulated: REGULATED_TYPES.has(input.claimType),
      evidenceIds: input.evidenceIds,
      entityIds: input.entityIds,
      jurisdictions: input.jurisdictions,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdBy: actorRef(actor),
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict('an identical claim already exists');
  await audit(tx, tenantId, actor, 'knowledge.claim.proposed', { type: 'claim', id: row.id }, { claimType: row.claimType, regulated: row.regulated });
  return row;
}

export async function reviewClaim(tx: Tx, tenantId: string, actor: Actor, id: string, decision: 'approved' | 'rejected') {
  const [c] = await tx.select().from(claims).where(eq(claims.id, id)).for('update');
  if (!c) throw notFound('claim');
  requireRole(actor, c.regulated ? ['legal_approver', 'owner'] : ['approver', 'legal_approver', 'owner', 'admin'], c.regulated ? 'approving regulated claims' : 'approving claims');
  if (c.createdBy === actorRef(actor)) throw invalid('claims must be approved by someone other than their author');
  const [row] = await tx
    .update(claims)
    .set({ status: decision, approvedBy: decision === 'approved' ? actorRef(actor) : null, approvedAt: decision === 'approved' ? new Date() : null })
    .where(eq(claims.id, id))
    .returning();
  if (decision === 'approved') await record(tx, tenantId, actor, 'knowledge.claim.approved', { type: 'claim', id }, { claimType: c.claimType });
  else await audit(tx, tenantId, actor, 'knowledge.claim.rejected', { type: 'claim', id }, {});
  return row!;
}

/** Expire claims past their date or whose evidence/facts are no longer trustworthy. */
export async function sweepClaims(tx: Tx, tenantId: string, actor: Actor, now: Date): Promise<string[]> {
  const approved = await tx.select().from(claims).where(eq(claims.status, 'approved'));
  const expired: string[] = [];
  for (const c of approved) {
    let reason: string | null = null;
    if (c.expiresAt && c.expiresAt <= now) reason = 'expired';
    else {
      const ev = await tx.select().from(evidenceRecords).where(inArray(evidenceRecords.id, c.evidenceIds));
      if (ev.length === 0 || ev.every((e) => e.status !== 'admitted' || effectiveFreshness(e, now) === 'stale')) reason = 'evidence no longer current';
      else if (c.entityIds.length) {
        const ents = await tx.select().from(kgEntities).where(inArray(kgEntities.id, c.entityIds));
        if (ents.some((e) => e.status !== 'active')) reason = 'underlying fact superseded or in conflict';
      }
    }
    if (reason) {
      await tx.update(claims).set({ status: 'expired' }).where(eq(claims.id, c.id));
      await record(tx, tenantId, actor, 'knowledge.claim.expired', { type: 'claim', id: c.id }, { reason });
      expired.push(c.id);
    }
  }
  return expired;
}

/* ------------------------------------------------------------------ */
/* Brand rules + copy lint (used by M13/M14/M16/M20/M21)                */
/* ------------------------------------------------------------------ */

export const BrandRuleSchema = z.object({
  kind: z.enum(['banned_phrase', 'banned_regex', 'required_phrase', 'max_exclamations', 'tone_note']),
  pattern: z.string().min(1).max(500),
  severity: z.enum(['block', 'warn']),
  description: z.string().min(3).max(1000),
  channels: z.array(z.string()).default([]),
});

export async function addBrandRule(tx: Tx, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'approver'], 'editing brand rules');
  const input = BrandRuleSchema.parse(raw);
  if (input.kind === 'banned_regex') {
    try {
      new RegExp(input.pattern, 'iu');
    } catch {
      throw invalid('invalid regular expression');
    }
    if (input.pattern.length > 200 || /(\+|\*|\{\d+,?\d*\})\s*\)?\s*(\+|\*)/.test(input.pattern)) throw invalid('regex too complex (nested quantifiers are not allowed)');
  }
  if (input.kind === 'max_exclamations' && !/^\d{1,2}$/.test(input.pattern)) throw invalid('max_exclamations pattern must be a number');
  const [row] = await tx
    .insert(brandRules)
    .values({ tenantId, ...input, createdBy: actorRef(actor) })
    .returning();
  await audit(tx, tenantId, actor, 'knowledge.brand_rule.added', { type: 'brand_rule', id: row!.id }, { kind: input.kind });
  return row!;
}

export interface LintViolation {
  code: string;
  severity: 'block' | 'warn';
  message: string;
  excerpt: string;
}

export interface LintResult {
  passed: boolean;
  violations: LintViolation[];
  claimsChecked: string[];
}

/** Phrases that assert something checkable and therefore need an approved claim. */
const CLAIM_TRIGGERS: { code: string; re: RegExp; label: string }[] = [
  { code: 'SUPERLATIVE', re: /\b(best|#\s?1|number one|no\.\s?1|fastest|cheapest|leading|unbeatable|world'?s first|most (?:popular|trusted|advanced))\b/iu, label: 'superlative' },
  { code: 'ABSOLUTE', re: /\b(guarantee[ds]?|100\s?%|risk[- ]free|always works|never fails|forever)\b/iu, label: 'absolute promise' },
  { code: 'STATISTIC', re: /(\d+(?:[.,]\d+)?\s?(?:%|percent|x\b|times\b))|(\b(?:save|saves|saving)\s+(?:up to\s+)?[$€£]?\d)/iu, label: 'statistic' },
  { code: 'COMPARATIVE', re: /\b(better|faster|cheaper|stronger|more \w+) than\b|\bvs\.?\s+\w+/iu, label: 'comparison' },
  { code: 'TESTIMONIAL', re: /\b(customers? (?:say|love)|rated \d|[45](?:\.\d)? stars?|reviews? say|testimonial)/iu, label: 'testimonial' },
  { code: 'HEALTH', re: /\b(cures?|heals?|clinically (?:proven|tested)|doctor[- ]recommended|fda[- ]approved|treats?|prevents? (?:disease|illness))\b/iu, label: 'health claim' },
  { code: 'ENVIRONMENTAL', re: /\b(eco[- ]friendly|carbon[- ]neutral|sustainable|green(?:er)?|biodegradable|net[- ]zero|climate[- ]positive)\b/iu, label: 'environmental claim' },
  { code: 'FINANCIAL', re: /\b(earn|make)\s+[$€£]?\d|\b(passive income|get rich|returns? of)\b/iu, label: 'financial claim' },
  { code: 'SCARCITY', re: /\b(only \d+ left|limited (?:time|stock)|ends (?:tonight|today|soon)|last chance|while supplies last)\b/iu, label: 'scarcity/urgency' },
];

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokenSet(s: string): Set<string> {
  return new Set(
    normalizeText(s)
      .split(' ')
      .filter((w) => w.length > 2),
  );
}

function covered(sentence: string, claimTexts: string[]): boolean {
  const ns = normalizeText(sentence);
  const st = tokenSet(sentence);
  return claimTexts.some((c) => {
    if (ns.includes(c) || c.includes(ns)) return true;
    const ct = tokenSet(c);
    const inter = [...ct].filter((w) => st.has(w)).length;
    return ct.size > 0 && inter / ct.size >= 0.75;
  });
}

/**
 * Deterministic copy lint: every checkable assertion must map to an approved claim referenced by
 * the content, and brand rules must pass. LLM review may add findings but cannot remove these.
 */
export async function lintCopy(tx: DbOrTx, text: string, opts: { claimIds: string[]; channel?: string; requiredDisclosure?: string | null; now: Date }): Promise<LintResult> {
  const violations: LintViolation[] = [];
  const referenced = opts.claimIds.length ? await tx.select().from(claims).where(inArray(claims.id, opts.claimIds)) : [];
  const usable = referenced.filter((c) => c.status === 'approved' && (!c.expiresAt || c.expiresAt > opts.now));
  for (const c of referenced) {
    if (!usable.includes(c)) violations.push({ code: 'CLAIM_NOT_USABLE', severity: 'block', message: `claim ${c.id} is ${c.status}`, excerpt: c.text });
  }
  const claimTexts = usable.map((c) => c.normalizedText);
  for (const s of sentences(text)) {
    for (const t of CLAIM_TRIGGERS) {
      if (t.re.test(s) && !covered(s, claimTexts)) {
        violations.push({ code: `UNSUBSTANTIATED_${t.code}`, severity: 'block', message: `${t.label} without an approved claim`, excerpt: s.slice(0, 300) });
        break;
      }
    }
  }
  const rules = await tx.select().from(brandRules).where(eq(brandRules.active, true));
  const lower = text.toLowerCase();
  for (const r of rules) {
    if (r.channels.length && opts.channel && !r.channels.includes(opts.channel)) continue;
    const sev = r.severity as 'block' | 'warn';
    if (r.kind === 'banned_phrase' && lower.includes(r.pattern.toLowerCase())) violations.push({ code: 'BRAND_BANNED_PHRASE', severity: sev, message: r.description, excerpt: r.pattern });
    if (r.kind === 'banned_regex' && new RegExp(r.pattern, 'iu').test(text)) violations.push({ code: 'BRAND_BANNED_PATTERN', severity: sev, message: r.description, excerpt: r.pattern });
    if (r.kind === 'required_phrase' && !lower.includes(r.pattern.toLowerCase())) violations.push({ code: 'BRAND_REQUIRED_PHRASE_MISSING', severity: sev, message: r.description, excerpt: r.pattern });
    if (r.kind === 'max_exclamations' && (text.match(/!/g)?.length ?? 0) > Number(r.pattern)) violations.push({ code: 'BRAND_TOO_MANY_EXCLAMATIONS', severity: sev, message: r.description, excerpt: `max ${r.pattern}` });
  }
  if (opts.requiredDisclosure && !lower.includes(opts.requiredDisclosure.toLowerCase())) {
    violations.push({ code: 'DISCLOSURE_MISSING', severity: 'block', message: 'required disclosure text not present in copy', excerpt: opts.requiredDisclosure });
  }
  return { passed: !violations.some((v) => v.severity === 'block'), violations, claimsChecked: usable.map((c) => c.id) };
}

/* ------------------------------------------------------------------ */
/* Documents + retrieval                                               */
/* ------------------------------------------------------------------ */

export function chunkText(text: string, target = 1000, overlap = 150): string[] {
  const paras = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
  };
  for (const p of paras) {
    if (p.length > target * 1.5) {
      flush();
      cur = '';
      for (let i = 0; i < p.length; i += target - overlap) chunks.push(p.slice(i, i + target).trim());
      continue;
    }
    if (cur.length + p.length + 2 > target) {
      flush();
      cur = `${cur.slice(Math.max(0, cur.length - overlap))}\n\n${p}`.trim();
    } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  flush();
  return chunks;
}

export const DocumentInputSchema = z.object({
  title: z.string().min(1).max(300),
  text: z.string().min(1).max(2_000_000),
  evidenceId: z.string().uuid(),
  visibility: z.enum(['public', 'internal', 'restricted']),
  allowedRoles: z.array(z.string()).default([]),
});

export async function ingestDocument(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown, embedder?: Embedder) {
  const input = DocumentInputSchema.parse(raw);
  await requireTrustedEvidence(tx, [input.evidenceId], deps.clock.now());
  if (input.visibility === 'restricted' && input.allowedRoles.length === 0) throw invalid('restricted documents need allowedRoles');
  const hash = sha256Hex(input.text);
  const [existing] = await tx.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.contentSha256, hash));
  if (existing) return existing;
  const put = await deps.store.put(tenantKey(tenantId, 'knowledge', `${hash}.txt`), input.text, 'text/plain; charset=utf-8');
  const chunks = chunkText(input.text);
  const vectors = embedder ? await embedder.embed(chunks) : null;
  const [doc] = await tx
    .insert(knowledgeDocuments)
    .values({ tenantId, title: input.title, evidenceId: input.evidenceId, visibility: input.visibility, allowedRoles: input.allowedRoles, contentSha256: hash, objectKey: put.key, chunkCount: chunks.length, createdBy: actorRef(actor) })
    .returning();
  for (const [i, text] of chunks.entries()) {
    await tx.insert(knowledgeChunks).values({ tenantId, documentId: doc!.id, ordinal: i, text, embedding: vectors?.[i] ?? null, embeddingModel: vectors ? embedder!.model : null });
  }
  await record(tx, tenantId, actor, 'knowledge.document.indexed', { type: 'knowledge_document', id: doc!.id }, { chunks: chunks.length, embedded: Boolean(vectors) });
  return doc!;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  title: string;
  text: string;
  evidenceId: string;
  score: number;
  ftsRank: number | null;
  vectorRank: number | null;
}

/**
 * Hybrid retrieval. Full-text search is always available; when an embedder is configured the
 * exact cosine similarity is computed application-side (tech stack pgvector fallback) and both
 * rankings are fused with reciprocal-rank fusion. Only documents backed by admitted evidence and
 * visible to the caller's roles are returned.
 */
export async function searchKnowledge(tx: DbOrTx, args: { query: string; limit?: number; roles: string[]; audience: 'internal' | 'public'; embedder?: Embedder /** 'any' ORs the terms (conversational questions); default 'all'. */; match?: 'all' | 'any' }): Promise<RetrievedChunk[]> {
  const limit = Math.min(args.limit ?? 8, 50);
  const tsq = args.match === 'any' ? sql`to_tsquery('simple', replace(plainto_tsquery('english', ${args.query})::text, '&', '|'))` : sql`websearch_to_tsquery('english', ${args.query})`;
  const visibility = args.audience === 'public' ? sql`d.visibility = 'public'` : sql`(d.visibility in ('public','internal') or (d.visibility = 'restricted' and d.allowed_roles && ${sql.raw(`'{${args.roles.map((r) => r.replace(/[^a-z_]/g, '')).join(',')}}'`)}::text[]))`;
  const fts = await tx.execute<{ id: string; document_id: string; title: string; text: string; evidence_id: string; rank: number }>(sql`
    select c.id, c.document_id, d.title, c.text, d.evidence_id, ts_rank_cd(c.tsv, q) as rank
    from knowledge_chunks c join knowledge_documents d on d.id = c.document_id
    join evidence_records e on e.id = d.evidence_id and e.status = 'admitted',
    ${tsq} q
    where c.tsv @@ q and ${visibility}
    order by rank desc limit 50`);
  const ftsRanked = fts.rows.map((r, i) => ({ ...r, ftsRank: i + 1 }));
  let vecRanked: { id: string; document_id: string; title: string; text: string; evidence_id: string; vectorRank: number; sim: number }[] = [];
  if (args.embedder) {
    const [qv] = await args.embedder.embed([args.query]);
    const cand = await tx.execute<{ id: string; document_id: string; title: string; text: string; evidence_id: string; embedding: number[] }>(sql`
      select c.id, c.document_id, d.title, c.text, d.evidence_id, c.embedding
      from knowledge_chunks c join knowledge_documents d on d.id = c.document_id
      join evidence_records e on e.id = d.evidence_id and e.status = 'admitted'
      where c.embedding is not null and c.embedding_model = ${args.embedder.model} and ${visibility}
      limit 20000`);
    vecRanked = cand.rows
      .map((r) => ({ ...r, sim: cosine(qv!, r.embedding) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 50)
      .map((r, i) => ({ id: r.id, document_id: r.document_id, title: r.title, text: r.text, evidence_id: r.evidence_id, sim: r.sim, vectorRank: i + 1 }));
  }
  const K = 60;
  const merged = new Map<string, RetrievedChunk>();
  for (const r of ftsRanked) merged.set(r.id, { chunkId: r.id, documentId: r.document_id, title: r.title, text: r.text, evidenceId: r.evidence_id, score: 1 / (K + r.ftsRank), ftsRank: r.ftsRank, vectorRank: null });
  for (const r of vecRanked) {
    const m = merged.get(r.id);
    if (m) {
      m.score += 1 / (K + r.vectorRank);
      m.vectorRank = r.vectorRank;
    } else merged.set(r.id, { chunkId: r.id, documentId: r.document_id, title: r.title, text: r.text, evidenceId: r.evidence_id, score: 1 / (K + r.vectorRank), ftsRank: null, vectorRank: r.vectorRank });
  }
  return [...merged.values()].sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId)).slice(0, limit);
}

/**
 * Drop retrieved excerpts that carry prompt-injection markers before they reach a model. The
 * text is still fenced as untrusted data; this removes known attack shapes entirely.
 */
export function screenRetrieved(chunks: RetrievedChunk[]): { kept: RetrievedChunk[]; dropped: { chunkId: string; documentId: string; signals: string[] }[] } {
  const kept: RetrievedChunk[] = [];
  const dropped: { chunkId: string; documentId: string; signals: string[] }[] = [];
  for (const c of chunks) {
    const signals = injectionSignals(`${c.title}\n${c.text}`);
    if (signals.length) dropped.push({ chunkId: c.chunkId, documentId: c.documentId, signals });
    else kept.push(c);
  }
  return { kept, dropped };
}

export async function listClaims(tx: DbOrTx, status?: string) {
  return tx
    .select()
    .from(claims)
    .where(status ? eq(claims.status, status) : undefined)
    .orderBy(desc(claims.createdAt))
    .limit(500);
}
