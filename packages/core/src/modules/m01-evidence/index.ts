import { type EvidenceInput, EvidenceInputSchema, type EvidenceRecord, SOURCE_TYPES } from '@futuregrow/contracts';
import { type DbOrTx, evidenceRecords, sources, type Tx } from '@futuregrow/db';
import { conflict, invalid, notFound, sha256Canonical } from '@futuregrow/observability';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef } from '../../deps.js';
import { audit, record, requireRole } from '../../util.js';
import { effectiveFreshness } from '../m23-execution/facts.js';

const REVIEWER_ROLES = ['owner', 'admin', 'privacy_officer', 'legal_approver'] as const;

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

export const SourceInputSchema = z.object({
  name: z.string().min(1).max(200),
  sourceType: z.enum(SOURCE_TYPES),
  owner: z.string().min(1),
  uri: z.string().min(1).max(2000),
  licenseOrUsageRights: z.string().min(1).nullable(),
  termsVersion: z.string().nullable().default(null),
  permittedUses: z.array(z.string()).default([]),
  prohibitedUses: z.array(z.string()).default([]),
  defaultPiiClass: z.enum(['none', 'pseudonymous', 'personal', 'sensitive', 'children']).nullable().default(null),
  freshnessSlaHours: z.number().positive().nullable().default(null),
});

export async function registerSource(tx: Tx, tenantId: string, actor: Actor, raw: unknown) {
  const input = SourceInputSchema.parse(raw);
  const [row] = await tx
    .insert(sources)
    .values({ tenantId, ...input, status: 'pending_review' })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict(`source ${input.uri} already registered`);
  await audit(tx, tenantId, actor, 'evidence.source.registered', { type: 'source', id: row.id }, { uri: input.uri, sourceType: input.sourceType });
  return row;
}

export async function listSources(tx: DbOrTx) {
  return tx.select().from(sources).orderBy(desc(sources.createdAt)).limit(500);
}

export async function reviewSource(tx: Tx, tenantId: string, actor: Actor, id: string, decision: 'approved' | 'blocked') {
  requireRole(actor, REVIEWER_ROLES, 'reviewing a source');
  const [row] = await tx
    .update(sources)
    .set({ status: decision, reviewedBy: actorRef(actor), reviewedAt: new Date() })
    .where(eq(sources.id, id))
    .returning();
  if (!row) throw notFound('source');
  await audit(tx, tenantId, actor, 'evidence.source.reviewed', { type: 'source', id }, { decision });
  return row;
}

/* ------------------------------------------------------------------ */
/* Evidence admission                                                  */
/* ------------------------------------------------------------------ */

export interface AdmitOptions {
  now: Date;
  /** Skip the duplicate lookup (e.g. execution proofs are always new). */
  allowDuplicate?: boolean;
}

/**
 * Admit evidence. Anything with unresolved rights, PII class, confidence, lawful basis (for
 * personal data), platform terms (for external platforms) or acceptable freshness is stored in
 * quarantine: it is kept for review but cannot drive autonomous execution (product plan M01 AC).
 */
export async function admitEvidence(tx: Tx, tenantId: string, actor: Actor, raw: EvidenceInput, opts: AdmitOptions): Promise<EvidenceRecord> {
  const input = EvidenceInputSchema.parse(raw);
  let contentSha256 = input.contentSha256;
  if (input.content !== undefined && input.content !== null) {
    const computed = sha256Canonical(input.content);
    if (contentSha256 && contentSha256 !== computed) throw invalid('contentSha256 does not match content');
    contentSha256 = computed;
  }
  if (!contentSha256) throw invalid('either content or contentObjectKey + contentSha256 is required');
  if (input.contentObjectKey && !input.contentObjectKey.startsWith(`t/${tenantId}/`)) throw invalid('content object must live under the tenant prefix');

  let license = input.licenseOrUsageRights;
  let pii = input.piiClassification;
  let terms = input.platformTermsVersion;
  let sla = input.freshnessSlaHours;
  let permitted = [...input.permittedUses];
  let prohibited = [...input.prohibitedUses];
  const reasons: string[] = [];

  if (input.sourceId) {
    const [src] = await tx.select().from(sources).where(eq(sources.id, input.sourceId));
    if (!src) throw notFound('source');
    if (src.status === 'blocked') throw invalid('source is blocked');
    if (src.status === 'pending_review') reasons.push('source pending review');
    license ??= src.licenseOrUsageRights;
    pii ??= src.defaultPiiClass as typeof pii;
    terms ??= src.termsVersion;
    sla ??= src.freshnessSlaHours;
    // Source permissions bound what evidence may claim; prohibitions accumulate.
    if (src.permittedUses.length) permitted = permitted.length ? permitted.filter((u) => src.permittedUses.includes(u)) : ([...src.permittedUses] as typeof permitted);
    prohibited = [...new Set([...prohibited, ...(src.prohibitedUses as typeof prohibited)])];
  }

  if (!license) reasons.push('license/usage rights unknown');
  if (!pii) reasons.push('PII classification missing');
  if (input.confidence === null) reasons.push('confidence missing');
  if ((pii === 'personal' || pii === 'sensitive') && !input.lawfulBasisOrConsentId) reasons.push('personal data without lawful basis/consent reference');
  if (pii === 'children') reasons.push("children's data requires the COPPA policy path [BLOCK]");
  if (input.externalPlatform && !terms) reasons.push('external platform terms version missing');
  const overlap = permitted.filter((u) => prohibited.includes(u));
  if (overlap.length) permitted = permitted.filter((u) => !prohibited.includes(u));

  if (input.lineageParentIds.length) {
    const parents = await tx.select({ id: evidenceRecords.id }).from(evidenceRecords).where(inArray(evidenceRecords.id, input.lineageParentIds));
    if (parents.length !== new Set(input.lineageParentIds).size) throw invalid('lineage parent evidence not found');
  }

  const retrievedAt = new Date(input.retrievedAt);
  const observedAt = input.observedAt ? new Date(input.observedAt) : null;
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  const freshness = effectiveFreshness({ freshnessStatus: 'unknown', freshnessSlaHours: sla, observedAt, retrievedAt, expiresAt }, opts.now);
  if (freshness === 'stale') reasons.push('stale at admission');

  if (!opts.allowDuplicate) {
    const [dup] = await tx
      .select()
      .from(evidenceRecords)
      .where(and(eq(evidenceRecords.contentSha256, contentSha256), eq(evidenceRecords.sourceUriOrObjectId, input.sourceUriOrObjectId), eq(evidenceRecords.retrievedAt, retrievedAt)))
      .limit(1);
    if (dup) return toRecord(dup);
  }

  const status = reasons.length ? 'quarantined' : 'admitted';
  const [row] = await tx
    .insert(evidenceRecords)
    .values({
      tenantId,
      sourceId: input.sourceId,
      sourceType: input.sourceType,
      sourceOwner: input.sourceOwner,
      sourceUriOrObjectId: input.sourceUriOrObjectId,
      retrievedAt,
      observedAt,
      geography: input.geography,
      lawfulBasisOrConsentId: input.lawfulBasisOrConsentId,
      platformTermsVersion: terms,
      licenseOrUsageRights: license,
      schemaVersion: input.schemaVersion,
      lineageParentIds: input.lineageParentIds,
      piiClassification: pii,
      freshnessStatus: freshness,
      freshnessSlaHours: sla,
      confidence: input.confidence,
      permittedUses: permitted,
      prohibitedUses: prohibited,
      kind: input.kind,
      summary: input.summary,
      content: input.content ?? null,
      contentObjectKey: input.contentObjectKey,
      contentSha256,
      status,
      quarantineReasons: reasons,
      expiresAt,
    })
    .returning();
  await record(
    tx,
    tenantId,
    actor,
    status === 'admitted' ? 'evidence.record.admitted' : 'evidence.record.quarantined',
    { type: 'evidence', id: row!.id },
    {
      kind: input.kind,
      reasons,
      sha256: contentSha256,
    },
  );
  return toRecord(row!);
}

export const QuarantineResolutionSchema = z.object({
  licenseOrUsageRights: z.string().min(1).optional(),
  piiClassification: z.enum(['none', 'pseudonymous', 'personal', 'sensitive']).optional(),
  confidence: z.number().min(0).max(1).optional(),
  lawfulBasisOrConsentId: z.string().min(1).optional(),
  platformTermsVersion: z.string().min(1).optional(),
  note: z.string().min(3).max(2000),
});

/** Human review of quarantined evidence. Children's data can never be released here. */
export async function resolveQuarantine(tx: Tx, tenantId: string, actor: Actor, id: string, raw: unknown) {
  requireRole(actor, REVIEWER_ROLES, 'releasing quarantined evidence');
  const res = QuarantineResolutionSchema.parse(raw);
  const [e] = await tx.select().from(evidenceRecords).where(eq(evidenceRecords.id, id)).for('update');
  if (!e) throw notFound('evidence');
  if (e.status !== 'quarantined') throw conflict(`evidence is ${e.status}`);
  if (e.piiClassification === 'children') throw invalid("children's data cannot be released without the COPPA policy path");
  const next = {
    licenseOrUsageRights: res.licenseOrUsageRights ?? e.licenseOrUsageRights,
    piiClassification: res.piiClassification ?? e.piiClassification,
    confidence: res.confidence ?? e.confidence,
    lawfulBasisOrConsentId: res.lawfulBasisOrConsentId ?? e.lawfulBasisOrConsentId,
    platformTermsVersion: res.platformTermsVersion ?? e.platformTermsVersion,
  };
  const remaining: string[] = [];
  if (!next.licenseOrUsageRights) remaining.push('license/usage rights unknown');
  if (!next.piiClassification) remaining.push('PII classification missing');
  if (next.confidence === null) remaining.push('confidence missing');
  if ((next.piiClassification === 'personal' || next.piiClassification === 'sensitive') && !next.lawfulBasisOrConsentId) {
    remaining.push('personal data without lawful basis/consent reference');
  }
  if (e.quarantineReasons.includes('external platform terms version missing') && !next.platformTermsVersion) remaining.push('external platform terms version missing');
  const freshness = effectiveFreshness(e, new Date());
  if (freshness === 'stale') remaining.push('stale');
  const status = remaining.length ? 'quarantined' : 'admitted';
  const [row] = await tx
    .update(evidenceRecords)
    .set({ ...next, freshnessStatus: freshness, status, quarantineReasons: remaining, reviewedBy: actorRef(actor), reviewedAt: new Date() })
    .where(eq(evidenceRecords.id, id))
    .returning();
  await record(tx, tenantId, actor, status === 'admitted' ? 'evidence.record.released' : 'evidence.record.quarantined', { type: 'evidence', id }, { note: res.note, remaining });
  return toRecord(row!);
}

export async function rejectEvidence(tx: Tx, tenantId: string, actor: Actor, id: string, note: string) {
  requireRole(actor, REVIEWER_ROLES, 'rejecting evidence');
  const [row] = await tx
    .update(evidenceRecords)
    .set({ status: 'rejected', reviewedBy: actorRef(actor), reviewedAt: new Date() })
    .where(eq(evidenceRecords.id, id))
    .returning();
  if (!row) throw notFound('evidence');
  await record(tx, tenantId, actor, 'evidence.record.quarantined', { type: 'evidence', id }, { rejected: true, note });
  return toRecord(row);
}

/** Worker sweep: mark evidence past its expiry, and re-derive freshness for SLA-bound records. */
export async function sweepEvidenceFreshness(tx: Tx, tenantId: string, actor: Actor, now: Date): Promise<{ expired: number; stale: number }> {
  const expired = await tx
    .update(evidenceRecords)
    .set({ status: 'expired', freshnessStatus: 'stale' })
    .where(and(lt(evidenceRecords.expiresAt, now), inArray(evidenceRecords.status, ['admitted', 'quarantined'])))
    .returning({ id: evidenceRecords.id });
  const res = await tx.execute<{ id: string }>(sql`
    update evidence_records set freshness_status = 'stale'
    where status = 'admitted' and freshness_status <> 'stale' and freshness_sla_hours is not null
      and coalesce(observed_at, retrieved_at) + (freshness_sla_hours || ' hours')::interval < ${now}
    returning id`);
  for (const e of expired) await record(tx, tenantId, actor, 'evidence.record.expired', { type: 'evidence', id: e.id }, {});
  return { expired: expired.length, stale: res.rows.length };
}

export async function getEvidence(tx: DbOrTx, id: string): Promise<EvidenceRecord> {
  const [row] = await tx.select().from(evidenceRecords).where(eq(evidenceRecords.id, id));
  if (!row) throw notFound('evidence');
  return toRecord(row);
}

export async function listEvidence(tx: DbOrTx, filter: { status?: string; kind?: string; limit?: number }) {
  const conds = [];
  if (filter.status) conds.push(eq(evidenceRecords.status, filter.status));
  if (filter.kind) conds.push(eq(evidenceRecords.kind, filter.kind));
  const rows = await tx
    .select()
    .from(evidenceRecords)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(evidenceRecords.createdAt))
    .limit(Math.min(filter.limit ?? 100, 500));
  return rows.map(toRecord);
}

/** Lineage graph: ancestors and descendants up to `depth` hops. */
export async function evidenceLineage(tx: DbOrTx, id: string, depth = 5) {
  const ancestors = await tx.execute<{ id: string; depth: number }>(sql`
    with recursive up(id, depth) as (
      select unnest(lineage_parent_ids), 1 from evidence_records where id = ${id}
      union
      select unnest(e.lineage_parent_ids), up.depth + 1 from evidence_records e join up on e.id = up.id where up.depth < ${depth}
    ) select id, min(depth)::int as depth from up group by id`);
  const descendants = await tx.execute<{ id: string; depth: number }>(sql`
    with recursive down(id, depth) as (
      select id, 1 from evidence_records where ${id}::uuid = any(lineage_parent_ids)
      union
      select e.id, down.depth + 1 from evidence_records e join down on down.id = any(e.lineage_parent_ids) where down.depth < ${depth}
    ) select id, min(depth)::int as depth from down group by id`);
  return { id, ancestors: ancestors.rows, descendants: descendants.rows };
}

function toRecord(row: typeof evidenceRecords.$inferSelect): EvidenceRecord {
  return {
    evidenceId: row.id,
    tenantId: row.tenantId,
    sourceId: row.sourceId,
    sourceType: row.sourceType as EvidenceRecord['sourceType'],
    sourceOwner: row.sourceOwner,
    sourceUriOrObjectId: row.sourceUriOrObjectId,
    retrievedAt: row.retrievedAt.toISOString(),
    observedAt: row.observedAt?.toISOString() ?? null,
    geography: row.geography,
    lawfulBasisOrConsentId: row.lawfulBasisOrConsentId,
    platformTermsVersion: row.platformTermsVersion,
    licenseOrUsageRights: row.licenseOrUsageRights,
    schemaVersion: row.schemaVersion,
    lineageParentIds: row.lineageParentIds,
    piiClassification: row.piiClassification as EvidenceRecord['piiClassification'],
    confidence: row.confidence,
    permittedUses: row.permittedUses as EvidenceRecord['permittedUses'],
    prohibitedUses: row.prohibitedUses as EvidenceRecord['prohibitedUses'],
    kind: row.kind as EvidenceRecord['kind'],
    summary: row.summary,
    content: row.content,
    contentObjectKey: row.contentObjectKey,
    contentSha256: row.contentSha256,
    externalPlatform: row.platformTermsVersion !== null,
    freshnessSlaHours: row.freshnessSlaHours,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    status: row.status as EvidenceRecord['status'],
    quarantineReasons: row.quarantineReasons,
    freshnessStatus: row.freshnessStatus as EvidenceRecord['freshnessStatus'],
    createdAt: row.createdAt.toISOString(),
  };
}

/** Convenience for internal producers (analytics, connectors, proofs). */
export async function admitInternalEvidence(
  tx: Tx,
  tenantId: string,
  actor: Actor,
  args: {
    kind: EvidenceInput['kind'];
    sourceType?: EvidenceInput['sourceType'];
    owner: string;
    uri: string;
    content: unknown;
    summary: string;
    confidence: number;
    license: string;
    pii?: 'none' | 'pseudonymous' | 'personal';
    lawfulBasis?: string | null;
    permittedUses: EvidenceInput['permittedUses'];
    parents?: string[];
    externalPlatformTerms?: string | null;
    observedAt?: Date;
    freshnessSlaHours?: number | null;
    now: Date;
  },
): Promise<EvidenceRecord> {
  return admitEvidence(
    tx,
    tenantId,
    actor,
    {
      sourceType: args.sourceType ?? 'internal',
      sourceOwner: args.owner,
      sourceUriOrObjectId: args.uri,
      retrievedAt: args.now.toISOString(),
      observedAt: (args.observedAt ?? args.now).toISOString(),
      licenseOrUsageRights: args.license,
      schemaVersion: '1',
      piiClassification: args.pii ?? 'none',
      lawfulBasisOrConsentId: args.lawfulBasis ?? null,
      confidence: args.confidence,
      permittedUses: args.permittedUses,
      kind: args.kind,
      summary: args.summary,
      content: args.content,
      lineageParentIds: args.parents ?? [],
      externalPlatform: args.externalPlatformTerms !== undefined && args.externalPlatformTerms !== null,
      platformTermsVersion: args.externalPlatformTerms ?? null,
      freshnessSlaHours: args.freshnessSlaHours ?? null,
    },
    { now: args.now, allowDuplicate: true },
  );
}
