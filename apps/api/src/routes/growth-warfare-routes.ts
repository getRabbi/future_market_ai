import { growthWarfare, requireRole } from '@futuregrow/core';
import { growthCampaigns, growthChannelTasks } from '@futuregrow/db';
import { notFound } from '@futuregrow/observability';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type ApiContext, actorOf, tenantOf, tenantTx } from '../http.js';

const Id = z.object({ id: z.string().uuid() });
const BrandQ = z.object({ brandId: z.string().uuid().optional() });
const Body = z.record(z.string(), z.unknown());
const tags = ['growth-warfare'];
const { settings, signals, conquest, blitz, capture, rescue, darwin, copy } = growthWarfare;

/** Growth Warfare OS (D-054): Control Room API. Every write is role-checked; widening changes need MFA. */
export function registerGrowthWarfareRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = ctx;
  const now = () => deps.clock.now();

  /* ---------------- Overview, settings, emergency stop ---------------- */
  r.get('/v1/growth-warfare/overview', { schema: { tags, querystring: BrandQ } }, async (req) => tenantTx(ctx, req, (tx) => growthWarfare.controlRoom(tx, deps, tenantOf(req), req.query.brandId ?? null)));
  r.get('/v1/growth-warfare/settings', { schema: { tags } }, async (req) => tenantTx(ctx, req, (tx) => settings.getSettings(tx, tenantOf(req))));
  r.put('/v1/growth-warfare/settings', { schema: { tags, body: settings.SettingsPatchSchema } }, async (req) => tenantTx(ctx, req, (tx) => settings.updateSettings(tx, tenantOf(req), actorOf(req), req.body)));
  r.post('/v1/growth-warfare/emergency-stop', { schema: { tags, body: z.object({ reason: z.string().min(3).max(500) }) } }, async (req) => tenantTx(ctx, req, (tx) => growthWarfare.emergencyStop(tx, tenantOf(req), actorOf(req), req.body.reason)));
  r.post('/v1/growth-warfare/emergency-stop/release', { schema: { tags, body: z.object({ expectedVersion: z.number().int().min(1) }) } }, async (req) => tenantTx(ctx, req, (tx) => settings.releaseEmergencyStop(tx, tenantOf(req), actorOf(req), req.body.expectedVersion)));
  r.get('/v1/growth-warfare/brands/:id/config', { schema: { tags, params: Id } }, async (req) => tenantTx(ctx, req, (tx) => settings.getBrandConfig(tx, req.params.id)));
  r.put('/v1/growth-warfare/brands/:id/config', { schema: { tags, params: Id, body: Body } }, async (req) => tenantTx(ctx, req, (tx) => settings.putBrandConfig(tx, tenantOf(req), actorOf(req), req.params.id, req.body)));
  r.get('/v1/growth-warfare/history', { schema: { tags } }, async (req) => tenantTx(ctx, req, (tx) => growthWarfare.executionHistory(tx)));

  /* ---------------- F1 Market Signal Hunter ---------------- */
  r.post('/v1/growth-warfare/scan', { schema: { tags, body: z.object({ brandId: z.string().uuid().optional() }) } }, async (req) => {
    requireRole(actorOf(req), ['owner', 'admin', 'growth_operator'], 'scanning market signals');
    await tenantTx(ctx, req, (tx) => settings.requireFeature(tx, tenantOf(req), 'F1', req.body.brandId ?? null));
    return signals.scanTenant(deps, tenantOf(req), { force: true, brandId: req.body.brandId, actor: actorOf(req) });
  });
  r.get('/v1/growth-warfare/opportunities', { schema: { tags, querystring: BrandQ.extend({ status: z.string().max(200).optional() }) } }, async (req) => tenantTx(ctx, req, (tx) => signals.listOpportunities(tx, { brandId: req.query.brandId, status: req.query.status ? req.query.status.split(',') : undefined })));
  r.post('/v1/growth-warfare/opportunities/:id/review', { schema: { tags, params: Id, body: z.object({ decision: z.enum(['reviewing', 'accepted', 'dismissed']), note: z.string().max(1000).optional() }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => signals.reviewOpportunity(tx, tenantOf(req), actorOf(req), req.params.id, req.body)),
  );

  /* ---------------- F2 Conquest / F3 Blitz campaigns ---------------- */
  r.post('/v1/growth-warfare/opportunities/:id/conquest', { schema: { tags, params: Id } }, async (req, reply) => {
    const out = await tenantTx(ctx, req, (tx) => conquest.prepareConquest(tx, deps, tenantOf(req), actorOf(req), req.params.id));
    return reply.status(out.created ? 201 : 200).send(out);
  });
  r.post('/v1/growth-warfare/opportunities/:id/blitz', { schema: { tags, params: Id } }, async (req, reply) => {
    const out = await tenantTx(ctx, req, (tx) => blitz.prepareBlitz(tx, deps, tenantOf(req), actorOf(req), req.params.id));
    return reply.status(out.created ? 201 : 200).send(out);
  });
  r.get('/v1/growth-warfare/campaigns', { schema: { tags, querystring: BrandQ } }, async (req) =>
    tenantTx(ctx, req, (tx) =>
      tx
        .select()
        .from(growthCampaigns)
        .where(req.query.brandId ? eq(growthCampaigns.brandId, req.query.brandId) : undefined)
        .orderBy(desc(growthCampaigns.createdAt))
        .limit(200),
    ),
  );
  r.get('/v1/growth-warfare/campaigns/:id', { schema: { tags, params: Id } }, async (req) =>
    tenantTx(ctx, req, async (tx) => {
      const [c] = await tx.select().from(growthCampaigns).where(eq(growthCampaigns.id, req.params.id));
      if (!c) throw notFound('campaign');
      const tasks = await tx.select().from(growthChannelTasks).where(eq(growthChannelTasks.campaignId, c.id));
      return { campaign: c, tasks, creators: await blitz.creatorPerformance(tx, tenantOf(req), c.id) };
    }),
  );
  r.post('/v1/growth-warfare/campaigns/:id/approve', { schema: { tags, params: Id, body: z.object({ expectedVersion: z.number().int().min(1), acknowledge: z.array(z.string().max(60)).max(10).default([]) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => conquest.approveCampaign(tx, tenantOf(req), actorOf(req), req.params.id, req.body, now())),
  );
  r.post(
    '/v1/growth-warfare/campaigns/:id/tasks',
    {
      schema: {
        tags,
        params: Id,
        body: z.object({
          channels: z
            .array(z.enum(['facebook', 'instagram', 'email', 'paid_ads', 'owned_site', 'referral', 'partner', 'community', 'creator']))
            .max(9)
            .optional(),
        }),
      },
    },
    async (req) =>
      tenantTx(ctx, req, async (tx) => {
        requireRole(actorOf(req), ['owner', 'admin', 'growth_operator'], 'planning channel tasks');
        const [c] = await tx.select().from(growthCampaigns).where(eq(growthCampaigns.id, req.params.id));
        if (!c) throw notFound('campaign');
        const s = await settings.requireFeature(tx, tenantOf(req), 'F3', c.brandId);
        return blitz.planChannelTasks(tx, deps, tenantOf(req), c.id, s, { channels: req.body.channels });
      }),
  );
  r.post('/v1/growth-warfare/campaigns/:id/sync', { schema: { tags, params: Id } }, async (req) => blitz.syncCampaignOutcomes(deps, tenantOf(req), req.params.id));
  r.post('/v1/growth-warfare/campaigns/:id/copy-variants', { schema: { tags, params: Id, body: z.object({ variants: z.number().int().min(1).max(5).default(3) }) } }, async (req) => copy.aiCopyVariants(deps, tenantOf(req), actorOf(req), req.params.id, req.body));
  r.post('/v1/growth-warfare/campaigns/:id/community-replies', { schema: { tags, params: Id, body: z.object({ discussionUrl: z.string().url(), question: z.string().min(3).max(2000), groupId: z.string().uuid().nullable().default(null) }) } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => blitz.draftCommunityReply(tx, deps, tenantOf(req), actorOf(req), { campaignId: req.params.id, ...req.body }))),
  );
  r.post('/v1/growth-warfare/campaigns/:id/creators', { schema: { tags, params: Id, body: z.object({ creatorIds: z.array(z.string().uuid()).min(1).max(50) }) } }, async (req) => tenantTx(ctx, req, (tx) => blitz.selectCreators(tx, deps, tenantOf(req), actorOf(req), req.params.id, req.body.creatorIds)));
  r.get('/v1/growth-warfare/campaigns/:id/creators', { schema: { tags, params: Id } }, async (req) => tenantTx(ctx, req, (tx) => blitz.creatorPerformance(tx, tenantOf(req), req.params.id, { flagDuplicates: true })));
  r.post(
    '/v1/growth-warfare/tasks/:id/submit',
    {
      schema: {
        tags,
        params: Id,
        body: z.object({ scheduledAt: z.string().datetime({ offset: true }).optional(), assetIds: z.array(z.string().uuid()).max(10).optional(), geographies: z.array(z.string().min(2).max(10)).max(20).optional(), creatorId: z.string().uuid().optional(), contractId: z.string().uuid().optional() }),
      },
    },
    async (req) => blitz.submitTask(deps, tenantOf(req), actorOf(req), req.params.id, req.body),
  );
  r.post('/v1/growth-warfare/tasks/:id/done', { schema: { tags, params: Id, body: z.object({ url: z.string().url(), note: z.string().max(1000).optional(), groupId: z.string().uuid().nullable().optional() }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => blitz.confirmHumanTask(tx, tenantOf(req), actorOf(req), req.params.id, req.body)),
  );

  /* ---------------- F4 Acquisition tools & visibility ---------------- */
  r.get('/v1/growth-warfare/tools', { schema: { tags, querystring: BrandQ } }, async (req) => tenantTx(ctx, req, (tx) => capture.listTools(tx, req.query.brandId)));
  r.get('/v1/growth-warfare/tool-templates', { schema: { tags } }, async () => capture.TEMPLATE_INFO);
  r.post('/v1/growth-warfare/tools', { schema: { tags, body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => capture.createTool(tx, deps, tenantOf(req), actorOf(req), req.body))));
  r.put('/v1/growth-warfare/tools/:id', { schema: { tags, params: Id, body: Body } }, async (req) => tenantTx(ctx, req, (tx) => capture.updateTool(tx, deps, tenantOf(req), actorOf(req), req.params.id, req.body)));
  r.post('/v1/growth-warfare/tools/:id/:command', { schema: { tags, params: z.object({ id: z.string().uuid(), command: z.enum(['publish', 'retire']) }) } }, async (req) => tenantTx(ctx, req, (tx) => capture.publishTool(tx, deps, tenantOf(req), actorOf(req), req.params.id, req.params.command)));
  r.post('/v1/growth-warfare/tools/:id/preview', { schema: { tags, params: Id, body: z.object({ inputs: Body }) } }, async (req) =>
    tenantTx(ctx, req, async (tx) => {
      const [tool] = (await capture.listTools(tx)).filter((t) => t.id === req.params.id);
      if (!tool) throw notFound('tool');
      return { definition: capture.publicDefinition(tool.template as Parameters<typeof capture.evaluateTool>[0], tool.config), result: capture.evaluateTool(tool.template as Parameters<typeof capture.evaluateTool>[0], tool.config, req.body.inputs) };
    }),
  );
  r.get('/v1/growth-warfare/visibility', { schema: { tags, querystring: z.object({ brandId: z.string().uuid() }) } }, async (req) => tenantTx(ctx, req, (tx) => capture.visibilityReport(tx, req.query.brandId, now())));
  r.post('/v1/growth-warfare/visibility/import', { schema: { tags, body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => capture.importVisibility(tx, deps, tenantOf(req), actorOf(req), req.body))));

  /* ---------------- F5 Conversion rescue & referral loops ---------------- */
  r.get('/v1/growth-warfare/funnel', { schema: { tags, querystring: z.object({ brandId: z.string().uuid(), windowDays: z.coerce.number().int().min(7).max(180).default(30) }) } }, async (req) =>
    tenantTx(ctx, req, async (tx) => {
      const diagnosis = await rescue.diagnoseFunnel(tx, req.query.brandId, { windowDays: req.query.windowDays, now: now() });
      return { diagnosis, plan: await rescue.recoveryPlan(tx, deps, tenantOf(req), req.query.brandId, diagnosis) };
    }),
  );
  r.post('/v1/growth-warfare/rescue', { schema: { tags, body: z.object({ brandId: z.string().uuid() }) } }, async (req, reply) => {
    const out = await tenantTx(ctx, req, (tx) => rescue.prepareRescue(tx, deps, tenantOf(req), actorOf(req), req.body.brandId));
    return reply.status(out.created ? 201 : 200).send(out);
  });
  r.get('/v1/growth-warfare/referrals', { schema: { tags, querystring: z.object({ windowDays: z.coerce.number().int().min(7).max(180).default(30) }) } }, async (req) => tenantTx(ctx, req, (tx) => rescue.referralLoop(tx, { windowDays: req.query.windowDays, now: now(), pepper: deps.config.identifierPepper })));
  r.post('/v1/growth-warfare/referrals', { schema: { tags, body: z.object({ brandId: z.string().uuid(), template: z.enum(['give_get', 'invite_unlock', 'creator_code']) }) } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => rescue.prepareReferralCampaign(tx, deps, tenantOf(req), actorOf(req), req.body.brandId, req.body.template))),
  );
  r.get('/v1/growth-warfare/referrals/conversions/:id/eligibility', { schema: { tags, params: Id } }, async (req) => tenantTx(ctx, req, (tx) => rescue.rewardEligibility(tx, req.params.id, now())));

  /* ---------------- F6 Darwin ---------------- */
  r.get('/v1/growth-warfare/experiments', { schema: { tags, querystring: BrandQ } }, async (req) => tenantTx(ctx, req, (tx) => darwin.listPlans(tx, req.query.brandId)));
  r.post('/v1/growth-warfare/experiments', { schema: { tags, body: Body } }, async (req, reply) => {
    const out = await tenantTx(ctx, req, (tx) => darwin.proposePlan(tx, deps, tenantOf(req), actorOf(req), req.body));
    return reply.status(out.created ? 201 : 200).send(out);
  });
  r.post('/v1/growth-warfare/experiments/:id/approve', { schema: { tags, params: Id, body: z.object({ tactic: z.string().max(120).nullable().default(null), channel: z.string().max(40).nullable().default(null) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => darwin.approvePlan(tx, tenantOf(req), actorOf(req), req.params.id, req.body)),
  );
  r.post('/v1/growth-warfare/experiments/:id/start', { schema: { tags, params: Id } }, async (req) => darwin.startPlan(deps, tenantOf(req), actorOf(req), req.params.id));
  r.post('/v1/growth-warfare/experiments/:id/reject', { schema: { tags, params: Id, body: z.object({ reason: z.string().min(3).max(500) }) } }, async (req) => tenantTx(ctx, req, (tx) => darwin.rejectPlan(tx, tenantOf(req), actorOf(req), req.params.id, req.body.reason)));
  r.get('/v1/growth-warfare/learning', { schema: { tags, querystring: z.object({ brandId: z.string().uuid() }) } }, async (req) =>
    tenantTx(ctx, req, async (tx) => ({ memory: await darwin.listMemory(tx, req.query.brandId), priorities: await darwin.tacticPriorities(tx, req.query.brandId), followUps: await darwin.recommendFollowUps(tx, req.query.brandId), brainContext: await darwin.brainContext(tx, req.query.brandId) })),
  );
  r.post('/v1/growth-warfare/learning/sync', { schema: { tags, body: z.object({ brandId: z.string().uuid().optional() }) } }, async (req) => {
    requireRole(actorOf(req), ['owner', 'admin', 'growth_operator', 'analyst'], 'syncing learning');
    return darwin.syncLearning(deps, tenantOf(req), req.body.brandId);
  });

  /* ---------------- Public acquisition tool runtime (no sign-in) ---------------- */
  const Pub = z.object({ publicId: z.string().regex(/^[a-z0-9]{12,40}$/) });
  const limit = (max: number) => ({ public: true, rateLimit: { max, timeWindow: '1 minute' } });
  app.get('/v1/public/tools/:publicId', { config: limit(60), schema: { tags: ['public'], params: Pub, querystring: z.object({ anon: z.string().max(100).optional() }) } }, async (req) => {
    const { publicId } = req.params as z.infer<typeof Pub>;
    return capture.publicView(deps, publicId, (req.query as { anon?: string }).anon ?? null);
  });
  app.post('/v1/public/tools/:publicId/evaluate', { config: limit(30), schema: { tags: ['public'], params: Pub } }, async (req) => capture.publicEvaluate(deps, (req.params as z.infer<typeof Pub>).publicId, req.body));
  app.post('/v1/public/tools/:publicId/events', { config: limit(60), schema: { tags: ['public'], params: Pub } }, async (req, reply) => reply.status(202).send(await capture.publicEvent(deps, (req.params as z.infer<typeof Pub>).publicId, req.body)));
  app.post('/v1/public/tools/:publicId/lead', { config: limit(10), schema: { tags: ['public'], params: Pub } }, async (req, reply) => reply.status(201).send(await capture.publicLead(deps, (req.params as z.infer<typeof Pub>).publicId, req.body)));
}
