import { canonicalJson } from '@futuregrow/contracts';
import { type DbOrTx, mediaJobs, renderJobs, type Tx, videoProjects, withTenant } from '@futuregrow/db';
import { forbidden, invalid, sha256Hex } from '@futuregrow/observability';
import { and, desc, eq, gte, inArray, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, requireRole } from '../../util.js';
import { requestGenerativeVideo } from './generative-video.js';
import { GOOGLE_FLOW_URL, paidVideoUsage, previewVideoRoute, storedVideoRouting, VideoRouteRequestSchema } from './routing.js';
import { queueProjectRender } from './video.js';

/**
 * One entry point for "make this video": the router decides (deterministically, from real
 * readiness, cost and budgets) and the request goes to the existing machinery — a Remotion render
 * job, a manual Google Flow hand-off, or a paid generation job that needs explicit authorization.
 * Nothing pretends to succeed: an unavailable route is an error with the setup steps.
 */
export const VideoGenerationQueueSchema = z
  .object({
    route: VideoRouteRequestSchema,
    /** Remotion: the storyboard project to render. */
    videoProjectId: z.string().uuid().nullable().default(null),
    /** Generative providers: what to generate. The router supplies model, size and duration. */
    generation: z
      .object({ prompt: z.string().trim().min(5).max(2000), title: z.string().trim().min(1).max(200) })
      .strict()
      .nullable()
      .default(null),
    idempotencyKey: z.string().regex(/^[\x21-\x7e]{8,128}$/),
    /** The maximum charge explicitly accepted for a paid route; absent = paid routes are not considered. */
    authorizedMaxUsd: z.number().finite().min(0).max(1000).optional(),
  })
  .strict();

export async function queueVideoGeneration(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'creating videos');
  const input = VideoGenerationQueueSchema.parse(raw);
  const decision = await previewVideoRoute(t, deps, tenantId, { ...input.route, allowPaid: input.authorizedMaxUsd !== undefined });
  await audit(
    t,
    tenantId,
    actor,
    'media.video_routing.decided',
    { type: 'tenant_settings', id: tenantId },
    { policy: decision.policy, mode: decision.mode, execution: decision.execution, reason: decision.reason, estimateUsd: decision.estimateUsd, candidates: decision.candidates.map((c) => ({ mode: c.mode, eligible: c.eligible, problems: c.problems.length })) },
  );
  const summary = { policy: decision.policy, mode: decision.mode, execution: decision.execution, reason: decision.reason, estimateUsd: decision.estimateUsd, setup: decision.setup };
  switch (decision.execution) {
    case 'unavailable':
      throw forbidden(`${decision.reason}${decision.setup.length ? ` Setup: ${decision.setup.join(' ')}` : ''}`, { code: 'VIDEO_ROUTE_UNAVAILABLE', setup: decision.setup });
    case 'needs_authorization':
      throw forbidden(decision.reason, { code: 'PAID_AUTHORIZATION_REQUIRED', mode: decision.mode, estimateUsd: decision.estimateUsd });
    case 'manual':
      return { decision: summary, manual: { url: GOOGLE_FLOW_URL, steps: ['Open Google Flow and generate the clip with your own Google account.', 'Download the MP4.', 'Import it with "Import from Google Flow" and confirm the rights questions.'] } };
    case 'automatic': {
      if (!input.videoProjectId) throw invalid('a Remotion render needs videoProjectId (create the storyboard first)');
      return { decision: summary, videoProject: await queueProjectRender(t, deps, tenantId, actor, input.videoProjectId) };
    }
    default: {
      if (!input.generation) throw invalid('a generative route needs generation.prompt and generation.title');
      if (!decision.modelId || !decision.output) throw forbidden('No approved model or output size for this route.');
      const job = await requestGenerativeVideo(t, deps, tenantId, actor, {
        modelId: decision.modelId,
        prompt: input.generation.prompt,
        title: input.generation.title,
        seconds: input.route.seconds,
        width: decision.output.width,
        height: decision.output.height,
        imageAssetId: input.route.imageAssetId,
        idempotencyKey: input.idempotencyKey,
        authorizedMaxUsd: input.authorizedMaxUsd,
      });
      return { decision: summary, job };
    }
  }
}

/* ------------------------------------------------------------------ */
/* History and usage                                                   */
/* ------------------------------------------------------------------ */

export interface VideoJobRow {
  id: string;
  source: 'media_job' | 'render_job';
  mode: string;
  kind: string;
  status: string;
  statusReason: string | null;
  costUsd: number | null;
  costBasis: string | null;
  billingUnresolved: boolean;
  assetId: string | null;
  requestedBy: string;
  requestedAt: string;
  finishedAt: string | null;
}

export async function videoJobHistory(t: DbOrTx, deps: Pick<CoreDeps, 'clock'>, tenantId: string, limit = 50) {
  const media = await t
    .select()
    .from(mediaJobs)
    .where(inArray(mediaJobs.kind, ['ai_video', 'video_import']))
    .orderBy(desc(mediaJobs.requestedAt))
    .limit(limit);
  const renders = await t.select().from(renderJobs).where(eq(renderJobs.composition, 'scene_story')).orderBy(desc(renderJobs.requestedAt)).limit(limit);
  const rows: VideoJobRow[] = [
    ...media.map((m) => {
      const p = m.provenance as { costBasis?: string; billingUnresolved?: boolean };
      return {
        id: m.id,
        source: 'media_job' as const,
        mode: m.provider,
        kind: m.kind,
        status: m.status,
        statusReason: m.statusReason,
        costUsd: m.costUsd,
        costBasis: p.costBasis ?? null,
        billingUnresolved: p.billingUnresolved === true,
        assetId: m.assetId,
        requestedBy: m.requestedBy,
        requestedAt: m.requestedAt.toISOString(),
        finishedAt: m.finishedAt?.toISOString() ?? null,
      };
    }),
    ...renders.map((r) => ({
      id: r.id,
      source: 'render_job' as const,
      mode: 'remotion',
      kind: 'render',
      status: r.status,
      statusReason: r.statusReason,
      costUsd: 0,
      costBasis: 'no_provider_charge',
      billingUnresolved: false,
      assetId: r.outputAssetId,
      requestedBy: r.requestedBy,
      requestedAt: r.requestedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    })),
  ]
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    .slice(0, limit);
  return { jobs: rows, usage: await paidVideoUsage(t, tenantId, deps.clock.now()) };
}

/* ------------------------------------------------------------------ */
/* Daily automation (optional; a goal, not a guarantee)                */
/* ------------------------------------------------------------------ */

/** At most this many automated renders are in flight per tenant (CPU media worker). */
export const DAILY_MAX_IN_FLIGHT = 2;

const storyboardHash = (s: unknown) => sha256Hex(canonicalJson(s));

/**
 * Today's plan: how many template videos are still wanted, what blocks automation, and which
 * QA-passed storyboards would be rendered next. Storyboards identical to one already rendered
 * are skipped, so automation never produces duplicate content. Script and storyboard writing
 * stays with the Content Studio and its approvals; automation only renders what passed QA.
 */
export async function dailyVideoPlan(t: DbOrTx, deps: Pick<CoreDeps, 'clock'>, tenantId: string) {
  const { settings, remotionLicensed } = await storedVideoRouting(t, tenantId);
  const now = deps.clock.now();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const today = await t
    .select({ id: renderJobs.id, status: renderJobs.status })
    .from(renderJobs)
    .where(and(eq(renderJobs.composition, 'scene_story'), gte(renderJobs.requestedAt, day), notInArray(renderJobs.status, ['failed', 'blocked_license'])));
  const inFlight = await t
    .select({ id: renderJobs.id })
    .from(renderJobs)
    .where(and(eq(renderJobs.composition, 'scene_story'), inArray(renderJobs.status, ['queued', 'rendering'])));
  const blockers: string[] = [];
  if (!settings.dailyAutomation) blockers.push('Daily automation is OFF.');
  if (!settings.enabled.remotion) blockers.push('Remotion is OFF.');
  if (!remotionLicensed) blockers.push('The Remotion licence eligibility is not recorded.');
  const projects = await t.select().from(videoProjects).orderBy(videoProjects.updatedAt).limit(500);
  const rendered = new Set(projects.filter((p) => p.status === 'ready' || p.status === 'rendering').map((p) => storyboardHash(p.storyboard)));
  const seen = new Set<string>();
  const candidates: string[] = [];
  let duplicates = 0;
  for (const p of projects) {
    const qa = p.qa as { storyboard?: { passed?: boolean } };
    if (p.status !== 'storyboard' || qa.storyboard?.passed !== true) continue;
    const h = storyboardHash(p.storyboard);
    if (rendered.has(h) || seen.has(h)) {
      duplicates++;
      continue;
    }
    seen.add(h);
    candidates.push(p.id);
  }
  const remaining = Math.max(0, settings.dailyTarget - today.length);
  const slots = Math.max(0, Math.min(remaining, DAILY_MAX_IN_FLIGHT - inFlight.length));
  if (!candidates.length && remaining) blockers.push('No QA-passed storyboard is waiting; create or approve storyboards in the Video Studio.');
  return { target: settings.dailyTarget, renderedToday: today.length, inFlight: inFlight.length, remaining, slots, blockers, candidates: candidates.slice(0, slots), skippedDuplicates: duplicates };
}

/** Worker step: queues up to the free slots. Pauses (no work) whenever a blocker exists. */
export async function runDailyVideoAutomation(deps: CoreDeps, tenantId: string) {
  return withTenant(deps.db, { tenantId, actor: 'system:video-automation' }, async (t) => {
    const plan = await dailyVideoPlan(t, deps, tenantId);
    const actor = systemActor('video-automation');
    const queued: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    if (plan.blockers.some((b) => !b.startsWith('No QA-passed'))) return { plan, queued, skipped };
    for (const id of plan.candidates) {
      try {
        await t.transaction(async (sp) => queueProjectRender(sp as unknown as Tx, deps, tenantId, actor, id));
        queued.push(id);
      } catch (err) {
        skipped.push({ id, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    if (queued.length) await audit(t, tenantId, actor, 'media.video_automation.queued', { type: 'tenant_settings', id: tenantId }, { queued, skipped: skipped.length, target: plan.target, renderedToday: plan.renderedToday, by: actorRef(actor) });
    return { plan, queued, skipped };
  });
}
