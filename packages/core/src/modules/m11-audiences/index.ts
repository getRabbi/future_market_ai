import { desc, eq, sql, type SQL } from 'drizzle-orm';
import { canonicalJson } from '@futuregrow/contracts';
import { type DbOrTx, type Tx, segmentMembers, segmentSnapshots, segments } from '@futuregrow/db';
import { invalid, notFound, sha256Hex } from '@futuregrow/observability';
import { z } from 'zod';
import { type Actor, actorRef } from '../../deps.js';
import { audit, requireRole } from '../../util.js';

/** Sensitive attributes and common proxies (aligned with the analytics job's feature policy). */
const SENSITIVE = /(age|gender|sex|race|ethnic|religion|health|disab|pregnan|sexual|political|union|biometric|genetic|zip|postal|postcode|nationality|immigration)/i;

const Op = z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'exists']);

const Condition = z.union([
  z.object({ field: z.enum(['country', 'locale', 'timezone']), op: z.enum(['eq', 'neq', 'in']), value: z.union([z.string().max(64), z.array(z.string().max(64)).max(200)]) }),
  z.object({ trait: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), op: Op, value: z.union([z.string().max(200), z.number(), z.boolean()]).optional() }),
  z.object({ event: z.string().min(1).max(200), windowDays: z.number().int().min(1).max(730), op: z.enum(['gte', 'lte', 'eq']), count: z.number().int().min(0) }),
  z.object({ propensityModelId: z.string().uuid(), op: z.enum(['gte', 'lte']), value: z.number().min(0).max(1) }),
]);
type Cond = z.infer<typeof Condition>;

export const SegmentInputSchema = z.object({
  name: z.string().min(2).max(200),
  description: z.string().max(2000).optional(),
  purpose: z.enum(['marketing_email', 'ads_customer_match', 'personalization', 'analytics']),
  definition: z.object({ all: z.array(Condition).max(20).default([]), any: z.array(Condition).max(20).default([]) }).refine((d) => d.all.length + d.any.length > 0, 'at least one condition'),
});

/** Consent required to include a profile for each purpose. */
const PURPOSE_CONSENT: Record<string, string | null> = {
  marketing_email: 'marketing_email',
  ads_customer_match: 'ads_customer_match',
  personalization: 'personalization',
  analytics: null,
};
const PURPOSE_SUPPRESSION: Record<string, string[]> = {
  marketing_email: ['email', 'all'],
  ads_customer_match: ['ads', 'all'],
  personalization: ['all'],
  analytics: [],
};

export function usesSensitive(def: { all: Cond[]; any: Cond[] }): string[] {
  return [...def.all, ...def.any].flatMap((c) => ('trait' in c && SENSITIVE.test(c.trait) ? [c.trait] : []));
}

const cmp = (op: string): SQL => sql.raw({ eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op] ?? '=');

function compile(c: Cond): SQL {
  if ('field' in c) {
    const col = sql.raw(`p.${c.field}`);
    if (c.op === 'in') {
      const vals = Array.isArray(c.value) ? c.value : [c.value];
      if (vals.length === 0) return sql`false`;
      return sql`${col} in (${sql.join(vals.map((v) => sql`${v}`), sql`, `)})`;
    }
    return sql`${col} ${cmp(c.op)} ${String(c.value)}`;
  }
  if ('trait' in c) {
    if (c.op === 'exists') return sql`p.traits ? ${c.trait}`;
    if (typeof c.value === 'number') return sql`(p.traits->>${c.trait})::numeric ${cmp(c.op)} ${c.value}`;
    if (typeof c.value === 'boolean') return sql`(p.traits->>${c.trait})::boolean ${cmp(c.op === 'neq' ? 'neq' : 'eq')} ${c.value}`;
    if (c.op === 'in') throw invalid('trait "in" requires a list; use field conditions');
    return sql`p.traits->>${c.trait} ${cmp(c.op)} ${c.value ?? ''}`;
  }
  if ('event' in c) {
    return sql`(select count(*) from customer_events e where e.profile_id = p.id and e.event_name = ${c.event} and e.occurred_at >= now() - make_interval(days => ${c.windowDays})) ${cmp(c.op)} ${c.count}`;
  }
  return sql`exists (select 1 from propensity_scores s where s.profile_id = p.id and s.model_id = ${c.propensityModelId} and s.score ${cmp(c.op)} ${c.value})`;
}

export async function defineSegment(tx: Tx, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator', 'analyst'], 'defining segments');
  const input = SegmentInputSchema.parse(raw);
  const sensitive = usesSensitive(input.definition);
  const [latest] = await tx.select().from(segments).where(eq(segments.name, input.name)).orderBy(desc(segments.version)).limit(1);
  const [row] = await tx
    .insert(segments)
    .values({
      tenantId,
      name: input.name,
      description: input.description ?? null,
      definition: input.definition as unknown as Record<string, unknown>,
      definitionSha256: sha256Hex(canonicalJson(input.definition)),
      purpose: input.purpose,
      usesSensitiveAttributes: sensitive.length > 0,
      status: sensitive.length ? 'blocked' : 'active',
      version: (latest?.version ?? 0) + 1,
      createdBy: actorRef(actor),
    })
    .returning();
  await audit(tx, tenantId, actor, 'audience.segment.defined', { type: 'segment', id: row!.id }, { purpose: input.purpose, sensitive });
  return row!;
}

/**
 * Materialise a segment. Deleted profiles, children, profiles without the purpose's consent and
 * suppressed identifiers are excluded at query time (suppression always overrides targeting).
 */
export async function computeSnapshot(tx: Tx, tenantId: string, segmentId: string, pepperHash: (email: string) => string) {
  const [seg] = await tx.select().from(segments).where(eq(segments.id, segmentId));
  if (!seg) throw notFound('segment');
  if (seg.status !== 'active') throw invalid(`segment is ${seg.status}`);
  const def = seg.definition as unknown as { all: Cond[]; any: Cond[] };
  const parts: SQL[] = [sql`p.deleted_at is null`, sql`p.merged_into_id is null`, sql`coalesce(p.is_child, false) = false`];
  for (const c of def.all) parts.push(compile(c));
  if (def.any.length) parts.push(sql`(${sql.join(def.any.map(compile), sql` or `)})`);
  const where = sql.join(parts, sql` and `);
  const base = await tx.execute<{ id: string; email: string | null }>(sql`select p.id, p.email from customer_profiles p where ${where}`);
  const consent = PURPOSE_CONSENT[seg.purpose];
  let consented = new Set(base.rows.map((r) => r.id));
  if (consent) {
    const c = await tx.execute<{ profile_id: string }>(
      sql`select profile_id from consent_state where purpose = ${consent} and status = 'granted' and (expires_at is null or expires_at > now())`,
    );
    const ok = new Set(c.rows.map((r) => r.profile_id));
    consented = new Set([...consented].filter((id) => ok.has(id)));
  }
  const channels = PURPOSE_SUPPRESSION[seg.purpose] ?? [];
  let suppressedIds = new Set<string>();
  if (channels.length) {
    const sup = await tx.execute<{ identifier_hash: string }>(sql`select identifier_hash from suppressions where channel in (${sql.join(channels.map((c) => sql`${c}`), sql`, `)})`);
    const hashes = new Set(sup.rows.map((r) => r.identifier_hash));
    suppressedIds = new Set(base.rows.filter((r) => r.email && hashes.has(pepperHash(r.email))).map((r) => r.id));
  }
  const members = base.rows.map((r) => r.id).filter((id) => consented.has(id) && !suppressedIds.has(id));
  const [snap] = await tx
    .insert(segmentSnapshots)
    .values({
      tenantId,
      segmentId,
      definitionSha256: seg.definitionSha256,
      size: members.length,
      excludedByConsent: base.rows.length - consented.size,
      excludedBySuppression: [...consented].filter((id) => suppressedIds.has(id)).length,
    })
    .returning();
  for (let i = 0; i < members.length; i += 1000) {
    await tx.insert(segmentMembers).values(members.slice(i, i + 1000).map((profileId) => ({ tenantId, snapshotId: snap!.id, profileId })));
  }
  return snap!;
}

export async function listSegments(tx: DbOrTx) {
  return tx.select().from(segments).orderBy(desc(segments.createdAt)).limit(500);
}

export async function snapshotMembers(tx: DbOrTx, snapshotId: string, limit = 1000) {
  return tx.select().from(segmentMembers).where(eq(segmentMembers.snapshotId, snapshotId)).limit(limit);
}
