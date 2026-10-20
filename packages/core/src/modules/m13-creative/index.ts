import { PROMPTS, untrustedBlock } from '@futuregrow/agent-kernel';
import { claims, creativeBriefs, type DbOrTx, growthIdeas, type Tx, withTenant } from '@futuregrow/db';
import { conflict, invalid, notFound } from '@futuregrow/observability';
import { desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { runAgent } from '../../agents.js';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { record, requireRole } from '../../util.js';
import { lintCopy } from '../m03-knowledge/index.js';

export const CHANNELS = ['facebook', 'instagram', 'tiktok', 'youtube', 'email', 'search_ads', 'display', 'landing_page'] as const;

export const BriefSchema = z.object({
  title: z.string().min(3).max(200),
  objective: z.string().min(3).max(500),
  channel: z.enum(CHANNELS),
  audience: z.string().min(3).max(500),
  angle: z.string().min(3).max(1000),
  hooks: z.array(z.string().min(3).max(300)).min(1).max(10),
  proofPoints: z.array(z.object({ text: z.string().min(3).max(500), claimId: z.string().uuid() })).max(10),
  cta: z.string().min(2).max(120),
  formatPlan: z.object({ format: z.string().max(100), aspectRatio: z.enum(['9:16', '1:1', '4:5', '16:9', 'n/a']), durationSeconds: z.number().int().positive().max(600).nullable().default(null), notes: z.string().max(1000).default('') }),
  prohibitedClaims: z.array(z.string().max(300)).max(20).default([]),
  experimentMatrix: z
    .array(z.object({ variant: z.string().max(40), hook: z.string().max(300), cta: z.string().max(120) }))
    .max(8)
    .default([]),
  ideaId: z.string().uuid().nullable().default(null),
});
export type BriefInput = z.infer<typeof BriefSchema>;

/** Lint every piece of copy and require each proof point to map to an approved claim (M13 AC). */
async function validateBrief(tx: Tx, deps: CoreDeps, b: BriefInput) {
  const claimIds = [...new Set(b.proofPoints.map((p) => p.claimId))];
  const rows = claimIds.length ? await tx.select().from(claims).where(inArray(claims.id, claimIds)) : [];
  const problems: string[] = [];
  for (const id of claimIds) {
    const c = rows.find((r) => r.id === id);
    if (!c) problems.push(`claim ${id} not found`);
    else if (c.status !== 'approved') problems.push(`claim ${id} is ${c.status}`);
  }
  const copy = [...b.hooks, b.cta, b.angle, ...b.proofPoints.map((p) => p.text), ...b.experimentMatrix.flatMap((v) => [v.hook, v.cta])].join('\n');
  const lint = await lintCopy(tx, copy, { claimIds, channel: b.channel, now: deps.clock.now() });
  return { passed: problems.length === 0 && lint.passed, problems, lint, evidenceIds: [...new Set(rows.flatMap((r) => r.evidenceIds))] };
}

export async function createBrief(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown, agentRunId: string | null = null) {
  const b = BriefSchema.parse(raw);
  const v = await validateBrief(tx, deps, b);
  let evidenceIds = v.evidenceIds;
  if (b.ideaId) {
    const [idea] = await tx.select().from(growthIdeas).where(eq(growthIdeas.id, b.ideaId));
    if (!idea) throw notFound('idea');
    evidenceIds = [...new Set([...evidenceIds, ...idea.evidenceIds])];
  }
  if (!evidenceIds.length) throw invalid('a brief needs at least one approved claim or a linked idea with evidence');
  const [row] = await tx
    .insert(creativeBriefs)
    .values({
      tenantId,
      title: b.title,
      objective: b.objective,
      channel: b.channel,
      audience: b.audience,
      angle: b.angle,
      hooks: b.hooks,
      proofPoints: b.proofPoints,
      cta: b.cta,
      formatPlan: b.formatPlan,
      prohibitedClaims: b.prohibitedClaims,
      experimentMatrix: b.experimentMatrix,
      lint: { passed: v.passed, problems: v.problems, violations: v.lint.violations },
      evidenceIds,
      ideaId: b.ideaId,
      agentRunId,
      status: v.passed ? 'draft' : 'lint_failed',
      createdBy: actorRef(actor),
    })
    .returning();
  await record(tx, tenantId, actor, 'creative.brief.created', { type: 'creative_brief', id: row!.id }, { status: row!.status, channel: b.channel });
  return row!;
}

export async function approveBrief(tx: Tx, tenantId: string, actor: Actor, id: string) {
  requireRole(actor, ['owner', 'admin', 'approver'], 'approving creative briefs');
  const [b] = await tx.select().from(creativeBriefs).where(eq(creativeBriefs.id, id)).for('update');
  if (!b) throw notFound('brief');
  if (b.status !== 'draft') throw conflict(`brief is ${b.status}`);
  const [row] = await tx.update(creativeBriefs).set({ status: 'approved' }).where(eq(creativeBriefs.id, id)).returning();
  await record(tx, tenantId, actor, 'creative.brief.created', { type: 'creative_brief', id }, { status: 'approved' });
  return row!;
}

const GeneratedBrief = z.object({
  abstain: z.boolean(),
  abstainReason: z.string(),
  title: z.string(),
  angle: z.string(),
  hooks: z.array(z.string()),
  proofPoints: z.array(z.object({ text: z.string(), claimId: z.string() })),
  cta: z.string(),
  format: z.string(),
  aspectRatio: z.enum(['9:16', '1:1', '4:5', '16:9', 'n/a']),
  durationSeconds: z.number(),
  formatNotes: z.string(),
  prohibitedClaims: z.array(z.string()),
  experimentMatrix: z.array(z.object({ variant: z.string(), hook: z.string(), cta: z.string() })),
});

export async function generateBrief(deps: CoreDeps, tenantId: string, actor: Actor, input: { objective: string; channel: (typeof CHANNELS)[number]; audience: string; ideaId?: string }) {
  return runAgent(deps, tenantId, { kind: 'brief_generation', agentId: 'creative-strategist', triggeredBy: actorRef(actor), input }, async (ctx) => {
    const mat = await withTenant(deps.db, { tenantId, actor: 'agent:creative-strategist' }, async (tx) => {
      const approved = await tx.select().from(claims).where(eq(claims.status, 'approved')).orderBy(desc(claims.approvedAt)).limit(40);
      const idea = input.ideaId ? (await tx.select().from(growthIdeas).where(eq(growthIdeas.id, input.ideaId)))[0] : undefined;
      return { approved: approved.filter((c) => !c.expiresAt || c.expiresAt > deps.clock.now()), idea };
    });
    if (!mat.approved.length) {
      ctx.note('observe', { approvedClaims: 0 });
      throw invalid('no approved claims are available to substantiate creative');
    }
    const r = await ctx.think('brief', PROMPTS.creativeBrief, {
      purpose: 'generation',
      outputSchema: GeneratedBrief,
      messages: [
        {
          role: 'user',
          content: [
            `Objective: ${input.objective}\nChannel: ${input.channel}\nAudience: ${input.audience}`,
            mat.idea ? untrustedBlock('idea', `${mat.idea.title}: ${mat.idea.hypothesis}`) : '',
            `Approved claims (only these may be used as proof points):\n${mat.approved.map((c) => `- claim ${c.id}: ${c.text}`).join('\n')}`,
          ].join('\n\n'),
        },
      ],
    });
    if (r.output.abstain) return { briefId: null, abstained: r.output.abstainReason };
    const ok = new Set(mat.approved.map((c) => c.id));
    const kept = r.output.proofPoints.filter((p) => ok.has(p.claimId));
    ctx.note('validate', { proofPointsProposed: r.output.proofPoints.length, kept: kept.length });
    const brief = await withTenant(deps.db, { tenantId, actor: 'agent:creative-strategist' }, (tx) =>
      createBrief(
        tx,
        deps,
        tenantId,
        { type: 'agent', id: 'creative-strategist', roles: [], mfaVerified: false },
        {
          title: r.output.title || input.objective,
          objective: input.objective,
          channel: input.channel,
          audience: input.audience,
          angle: r.output.angle,
          hooks: r.output.hooks.slice(0, 10),
          proofPoints: kept,
          cta: r.output.cta,
          formatPlan: { format: r.output.format, aspectRatio: r.output.aspectRatio, durationSeconds: r.output.durationSeconds > 0 ? Math.round(r.output.durationSeconds) : null, notes: r.output.formatNotes },
          prohibitedClaims: r.output.prohibitedClaims,
          experimentMatrix: r.output.experimentMatrix.slice(0, 8),
          ideaId: input.ideaId ?? null,
        },
        ctx.runId,
      ),
    );
    return { briefId: brief.id, status: brief.status };
  });
}

export async function listBriefs(tx: DbOrTx) {
  return tx.select().from(creativeBriefs).orderBy(desc(creativeBriefs.createdAt)).limit(200);
}
