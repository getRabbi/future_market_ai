import { appGrowth, conversationsModule, creatorsModule, discovery, lifecycle, paidMedia, social } from '@futuregrow/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type ApiContext, actorOf, tenantOf, tenantTx } from '../http.js';

const Id = z.object({ id: z.string().uuid() });
const Body = z.record(z.string(), z.unknown());
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Geos = z.array(z.string().min(2)).default([]);

/** Routes for M16–M22 channels. Every external write is proposed through M23. */
export function registerChannelRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = ctx;
  r.get('/v1/app/apple-ads/reports', { schema: { tags: ['app-growth'] } }, async (req) => tenantTx(ctx, req, (tx) => appGrowth.appleAdsReporting.appleAdsReports(tx)));
  r.post('/v1/app/apple-ads/reports', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } }, schema: { tags: ['app-growth'], body: appGrowth.appleAdsReporting.AppleAdsReportRequest } }, async (req) => appGrowth.appleAdsReporting.syncAppleAdsReport(deps, tenantOf(req), actorOf(req), req.body));

  /* ---------------- M16 Organic social ---------------- */
  r.get('/v1/social/posts', { schema: { tags: ['social'] } }, async (req) => tenantTx(ctx, req, (tx) => social.listPosts(tx)));
  r.post('/v1/social/posts', { schema: { tags: ['social'], body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => social.schedulePost(tx, deps, tenantOf(req), actorOf(req), req.body))));
  r.get('/v1/social/stats', { schema: { tags: ['social'] } }, async (req) => tenantTx(ctx, req, (tx) => social.audienceStats(tx)));
  r.get('/v1/social/platforms', { schema: { tags: ['social'] } }, async (req) => tenantTx(ctx, req, (tx) => social.platformReadiness(tx, deps.clock.now())));
  r.post('/v1/social/caption-check', { schema: { tags: ['social'], body: z.object({ platform: z.enum(social.PLATFORMS), caption: z.string().min(1).max(70_000), link: z.string().url().nullable().optional(), images: z.number().int().min(0).max(20).optional() }).strict() } }, async (req) =>
    social.checkCaption(req.body.platform, req.body.caption, { link: req.body.link ?? null, images: req.body.images ?? 0 }),
  );
  r.get(
    '/v1/social/analytics/export.csv',
    { schema: { tags: ['social'], querystring: z.object({ brandId: z.string().uuid().optional(), platform: z.enum(['instagram', 'tiktok', 'youtube', 'linkedin']).optional(), days: z.coerce.number().int().min(1).max(365).optional() }) }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const out = await tenantTx(ctx, req, (tx) =>
        social.analytics.socialAnalyticsCsv(tx, tenantOf(req), actorOf(req), deps.clock.now(), { ...(req.query.brandId ? { brandId: req.query.brandId } : {}), ...(req.query.platform ? { platform: req.query.platform } : {}), ...(req.query.days ? { days: req.query.days } : {}) }),
      );
      return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${out.filename}"`).header('cache-control', 'no-store').send(out.csv);
    },
  );
  r.get('/v1/social/analytics', { schema: { tags: ['social'], querystring: z.object({ brandId: z.string().uuid().optional() }) } }, async (req) => tenantTx(ctx, req, (tx) => social.analytics.socialAnalyticsReport(tx, deps.clock.now(), req.query.brandId ? { brandId: req.query.brandId } : {})));
  r.post('/v1/social/connections/:id/analytics/sync', { schema: { tags: ['social'], params: Id } }, async (req) => social.analytics.syncSocialAnalytics(deps, tenantOf(req), req.params.id, { actor: actorOf(req) }));
  r.get('/v1/social/interactions', { schema: { tags: ['social'] } }, async (req) => tenantTx(ctx, req, (tx) => social.listInteractions(tx)));
  r.post('/v1/social/connections/:id/insights/sync', { schema: { tags: ['social'], params: Id } }, async (req) => social.syncPageInsights(deps, tenantOf(req), req.params.id, { actor: actorOf(req) }));
  r.post('/v1/social/connections/:id/posts/snapshot', { schema: { tags: ['social'], params: Id } }, async (req) => social.collectPagePostSnapshot(deps, tenantOf(req), req.params.id, { actor: actorOf(req) }));
  r.post('/v1/social/connections/:id/profile/sync', { schema: { tags: ['social'], params: Id } }, async (req) => social.syncPageProfile(deps, tenantOf(req), req.params.id, { actor: actorOf(req) }));
  r.get('/v1/social/drafts', { schema: { tags: ['social'] } }, async (req) => tenantTx(ctx, req, (tx) => social.listPostDrafts(tx)));
  r.post('/v1/social/drafts/:id/schedule', { schema: { tags: ['social'], params: Id, body: z.object({ scheduledAt: z.string().datetime({ offset: true }), geographies: Geos }) } }, async (req) => tenantTx(ctx, req, (tx) => social.scheduleDraft(tx, deps, tenantOf(req), actorOf(req), req.params.id, req.body)));
  r.post('/v1/social/drafts/:id/discard', { schema: { tags: ['social'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => social.discardDraft(tx, tenantOf(req), actorOf(req), req.params.id)));
  r.post('/v1/social/interactions/:id/draft-reply', { schema: { tags: ['social'], params: Id } }, async (req, reply) => reply.status(202).send(await social.draftReply(deps, tenantOf(req), actorOf(req), req.params.id)));
  r.post('/v1/social/interactions/:id/reply', { schema: { tags: ['social'], params: Id, body: z.object({ message: z.string().min(1).max(8000).optional(), geographies: Geos }) } }, async (req, reply) => reply.status(201).send(await social.proposeReply(deps, tenantOf(req), actorOf(req), req.params.id, req.body)));

  /* ---------------- M17 Paid media ---------------- */
  r.get('/v1/ads/optimizations', { schema: { tags: ['ads'] } }, async (req) => tenantTx(ctx, req, paidMedia.proactive.listOptimizationReviews));
  r.post(
    '/v1/ads/optimizations/:id/propose',
    {
      schema: {
        tags: ['ads'],
        params: Id,
        body: z.object({
          geographies: z
            .array(z.string().regex(/^[A-Z]{2}$/))
            .min(1)
            .max(50),
        }),
      },
    },
    async (req, reply) => reply.status(201).send(await paidMedia.proactive.submitOptimizationReview(deps, tenantOf(req), actorOf(req), req.params.id, req.body.geographies)),
  );
  r.get('/v1/ads/campaigns', { schema: { tags: ['ads'] } }, async (req) => tenantTx(ctx, req, (tx) => paidMedia.listCampaigns(tx)));
  r.get('/v1/ads/campaigns/:id/performance', { schema: { tags: ['ads'], params: Id, querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) } }, async (req) => tenantTx(ctx, req, (tx) => paidMedia.campaignPerformance(tx, req.params.id, req.query.days)));
  r.post('/v1/ads/connections/:id/sync', { schema: { tags: ['ads'], params: Id, body: z.object({ from: Day.optional(), to: Day.optional() }).default({}) } }, async (req) => {
    paidMedia.requireOperator(actorOf(req));
    const campaigns = await paidMedia.syncCampaigns(deps, tenantOf(req), req.params.id);
    const spend = await paidMedia.syncSpend(deps, tenantOf(req), req.params.id, req.body.from && req.body.to ? { from: req.body.from, to: req.body.to } : undefined);
    return { campaigns, spend };
  });
  r.post('/v1/ads/connections/:id/reconcile', { schema: { tags: ['ads'], params: Id, body: z.object({ start: Day, end: Day, tolerance: z.number().min(0).max(0.5).default(0.02) }) } }, async (req) => {
    paidMedia.requireOperator(actorOf(req));
    return paidMedia.reconcileSpend(deps, tenantOf(req), req.params.id, { start: req.body.start, end: req.body.end }, req.body.tolerance);
  });
  /* Paid campaign creation (P3-06): drafts → M23 (finance approval + two-factor) → created PAUSED → verified. */
  const C = paidMedia.campaignCreation;
  r.get('/v1/ads/drafts', { schema: { tags: ['ads'] } }, async (req) => tenantTx(ctx, req, (tx) => C.listCampaignDrafts(tx, tenantOf(req))));
  r.get('/v1/ads/creation-status', { schema: { tags: ['ads'] } }, async (req) => tenantTx(ctx, req, async (tx) => ({ meta: await C.creationEnabled(tx, 'meta'), google_ads: await C.creationEnabled(tx, 'google_ads') })));
  r.post('/v1/ads/drafts', { schema: { tags: ['ads'], body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => C.saveCampaignDraft(tx, deps, tenantOf(req), actorOf(req), req.body))));
  r.put('/v1/ads/drafts/:id', { schema: { tags: ['ads'], params: Id, body: Body } }, async (req) => tenantTx(ctx, req, (tx) => C.saveCampaignDraft(tx, deps, tenantOf(req), actorOf(req), req.body, req.params.id)));
  r.post('/v1/ads/drafts/:id/submit', { schema: { tags: ['ads'], params: Id } }, async (req, reply) => reply.status(201).send(await C.submitCampaignDraft(deps, tenantOf(req), actorOf(req), req.params.id)));
  r.post('/v1/ads/drafts/:id/cancel', { schema: { tags: ['ads'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => C.cancelCampaignDraft(tx, tenantOf(req), actorOf(req), req.params.id)));
  r.get('/v1/ads/drafts/:id/optimizations', { schema: { tags: ['ads'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => paidMedia.optimization.optimizationSuggestions(tx, req.params.id, deps.clock.now())));
  r.post('/v1/ads/drafts/:id/optimizations/:key/propose', { schema: { tags: ['ads'], params: z.object({ id: z.string().uuid(), key: z.enum(['turn_on', 'pause_cap_reached', 'pause_ended', 'pause_no_clicks', 'pause_low_ctr', 'pace_to_cap']) }) } }, async (req, reply) =>
    reply.status(201).send(await paidMedia.optimization.proposeOptimization(deps, tenantOf(req), actorOf(req), req.params.id, req.params.key)),
  );
  r.get('/v1/ads/reconciliations', { schema: { tags: ['ads'] } }, async (req) => tenantTx(ctx, req, (tx) => paidMedia.listReconciliations(tx)));
  r.post('/v1/ads/campaigns/:id/budget', { schema: { tags: ['ads'], params: Id, body: Body } }, async (req, reply) => reply.status(201).send(await paidMedia.proposeBudgetChange(deps, tenantOf(req), actorOf(req), req.params.id, req.body)));
  r.post('/v1/ads/campaigns/:id/status', { schema: { tags: ['ads'], params: Id, body: z.object({ status: z.enum(['PAUSED', 'ACTIVE']), geographies: Geos, evidenceIds: z.array(z.string().uuid()).default([]), rationale: z.string().min(10).max(2000) }) } }, async (req, reply) =>
    reply.status(201).send(await paidMedia.proposeStatusChange(deps, tenantOf(req), actorOf(req), req.params.id, req.body)),
  );

  /* ---------------- M18 SEO / ASO / AI discovery ---------------- */
  r.get('/v1/seo/audits', { schema: { tags: ['seo'] } }, async (req) => tenantTx(ctx, req, (tx) => discovery.listAudits(tx)));
  r.post('/v1/seo/audits', { schema: { tags: ['seo'], body: Body } }, async (req, reply) => reply.status(202).send(await tenantTx(ctx, req, (tx) => discovery.requestSeoAudit(tx, deps, tenantOf(req), actorOf(req), req.body))));
  r.get('/v1/seo/audits/:id', { schema: { tags: ['seo'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => discovery.auditDetail(tx, req.params.id)));
  const PeriodQuery = z.object({ siteUrl: z.string().min(4).max(500).optional(), periodStart: Day.optional(), periodEnd: Day.optional() });
  const periodOf = (q: { periodStart?: string | undefined; periodEnd?: string | undefined }) => (q.periodStart && q.periodEnd ? { period: { start: q.periodStart, end: q.periodEnd } } : {});
  r.get('/v1/seo/opportunities/grounded', { schema: { tags: ['seo'], querystring: PeriodQuery.extend({ minImpressions: z.coerce.number().int().min(1).max(1_000_000).optional() }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => discovery.groundedSeoOpportunities(tx, { ...(req.query.minImpressions ? { minImpressions: req.query.minImpressions } : {}), ...(req.query.siteUrl ? { siteUrl: req.query.siteUrl } : {}), ...periodOf(req.query) })),
  );
  r.post('/v1/seo/opportunities/ideas', { schema: { tags: ['seo'], body: PeriodQuery.extend({ limit: z.number().int().min(1).max(10).default(5) }).default({ limit: 5 }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => discovery.proposeSeoIdeas(tx, deps, tenantOf(req), actorOf(req), { limit: req.body.limit, ...(req.body.siteUrl ? { siteUrl: req.body.siteUrl } : {}), ...periodOf(req.body) })),
  );
  r.post('/v1/seo/keywords/upload', { schema: { tags: ['seo'], body: Body } }, async (req) => tenantTx(ctx, req, (tx) => discovery.uploadKeywordMetrics(tx, tenantOf(req), actorOf(req), req.body)));
  r.post('/v1/seo/search-console/sync', { schema: { tags: ['seo'], body: z.object({ connectionId: z.string().uuid(), siteUrl: z.string().min(4).optional(), startDate: Day, endDate: Day }) }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    paidMedia.requireOperator(actorOf(req));
    return discovery.syncSearchConsole(deps, tenantOf(req), req.body.connectionId, { ...req.body, trigger: 'manual' });
  });
  r.get('/v1/seo/search-console', { schema: { tags: ['seo'] } }, async (req) => tenantTx(ctx, req, (tx) => discovery.searchConsole.searchConsoleOverview(tx, deps.clock.now())));
  r.get('/v1/seo/search-console/performance', { schema: { tags: ['seo'], querystring: discovery.searchConsole.PerformanceQuerySchema } }, async (req) => tenantTx(ctx, req, (tx) => discovery.searchConsole.searchPerformance(tx, req.query)));
  r.get('/v1/seo/search-console/:id/properties', { schema: { tags: ['seo'], params: Id }, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => discovery.searchConsole.listProperties(deps, tenantOf(req), actorOf(req), req.params.id));
  r.put('/v1/seo/search-console/:id/property', { schema: { tags: ['seo'], params: Id, body: z.object({ siteUrl: z.string().min(4).max(500) }).strict() } }, async (req) => discovery.searchConsole.selectProperty(deps, tenantOf(req), actorOf(req), req.params.id, req.body.siteUrl));
  r.get('/v1/seo/opportunities', { schema: { tags: ['seo'], querystring: z.object({ minImpressions: z.coerce.number().int().min(1).default(100) }) } }, async (req) => tenantTx(ctx, req, (tx) => discovery.keywordOpportunities(tx, { minImpressions: req.query.minImpressions })));
  r.post('/v1/aso/validate', { schema: { tags: ['aso'], body: z.object({ store: z.enum(['app_store', 'google_play']), fields: z.record(z.string(), z.string()) }) } }, async (req) => ({
    checks: discovery.validateListingFields(req.body.store, req.body.fields),
    limits: discovery.STORE_LIMITS[req.body.store],
  }));
  r.get('/v1/aso/listings', { schema: { tags: ['aso'] } }, async (req) => tenantTx(ctx, req, (tx) => discovery.listListings(tx)));
  r.post('/v1/aso/listings', { schema: { tags: ['aso'], body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => discovery.createListingDraft(tx, deps, tenantOf(req), actorOf(req), req.body))));
  r.post('/v1/aso/listings/:id/approve', { schema: { tags: ['aso'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => discovery.approveListing(tx, tenantOf(req), actorOf(req), req.params.id)));
  r.post('/v1/aso/listings/:id/push', { schema: { tags: ['aso'], params: Id, body: z.object({ connectionId: z.string().uuid(), localizationId: z.string().min(1), geographies: Geos, evidenceIds: z.array(z.string().uuid()).default([]) }) } }, async (req, reply) =>
    reply.status(201).send(await discovery.proposeAppStoreUpdate(deps, tenantOf(req), actorOf(req), req.params.id, req.body)),
  );

  /* ---------------- M19 App growth ---------------- */
  r.get('/v1/app/installs/stats', { schema: { tags: ['app'] } }, async (req) => tenantTx(ctx, req, (tx) => appGrowth.installStats(tx)));
  r.get('/v1/app/applications', { schema: { tags: ['app'] } }, async (req) => tenantTx(ctx, req, (tx) => appGrowth.listApplications(tx)));
  r.get('/v1/app/campaigns', { schema: { tags: ['app'], querystring: appGrowth.CampaignQuerySchema } }, async (req) => tenantTx(ctx, req, (tx) => appGrowth.campaignConversions(tx, req.query, deps.clock.now())));
  r.get('/v1/app/attribution', { schema: { tags: ['app'], querystring: appGrowth.attribution.AttributionQuerySchema } }, async (req) => tenantTx(ctx, req, (tx) => appGrowth.attribution.attributionReport(tx, req.query, deps.clock.now())));
  r.get('/v1/app/attribution/apps', { schema: { tags: ['app'] } }, async (req) => tenantTx(ctx, req, (tx) => appGrowth.attribution.attributionApps(tx)));
  r.get('/v1/app/cohorts', { schema: { tags: ['app'], querystring: z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }), activationEvent: z.string().min(1).max(200) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => appGrowth.acquisitionCohorts(tx, { from: new Date(req.query.from), to: new Date(req.query.to), activationEvent: req.query.activationEvent })),
  );
  r.get('/v1/app/store-reports', { schema: { tags: ['app'] } }, async (req) => tenantTx(ctx, req, (tx) => appGrowth.listReports(tx)));
  r.post('/v1/app/store-reports/sync', { schema: { tags: ['app'], body: z.object({ connectionId: z.string().uuid(), reportDate: Day }) } }, async (req) => {
    paidMedia.requireOperator(actorOf(req));
    return appGrowth.syncAppStoreSales(deps, tenantOf(req), req.body.connectionId, req.body.reportDate);
  });

  /* ---------------- M20 Lifecycle ---------------- */
  r.get('/v1/lifecycle/templates', { schema: { tags: ['lifecycle'] } }, async (req) => tenantTx(ctx, req, (tx) => lifecycle.listTemplates(tx)));
  r.post('/v1/lifecycle/templates', { schema: { tags: ['lifecycle'], body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => lifecycle.createTemplate(tx, deps, tenantOf(req), actorOf(req), req.body))));
  r.post('/v1/lifecycle/templates/:id/approve', { schema: { tags: ['lifecycle'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => lifecycle.approveTemplate(tx, deps, tenantOf(req), actorOf(req), req.params.id)));
  r.get('/v1/lifecycle/journeys', { schema: { tags: ['lifecycle'] } }, async (req) => tenantTx(ctx, req, (tx) => lifecycle.listJourneys(tx)));
  r.post('/v1/lifecycle/journeys', { schema: { tags: ['lifecycle'], body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => lifecycle.createJourney(tx, tenantOf(req), actorOf(req), req.body))));
  r.post('/v1/lifecycle/journeys/:id/activate', { schema: { tags: ['lifecycle'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => lifecycle.activateJourney(tx, tenantOf(req), actorOf(req), req.params.id)));
  r.post('/v1/lifecycle/journeys/:id/pause', { schema: { tags: ['lifecycle'], params: Id, body: z.object({ reason: z.string().min(3) }) } }, async (req) => tenantTx(ctx, req, (tx) => lifecycle.pauseJourney(tx, tenantOf(req), actorOf(req), req.params.id, req.body.reason)));
  r.get('/v1/lifecycle/journeys/:id/stats', { schema: { tags: ['lifecycle'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => lifecycle.journeyStats(tx, req.params.id)));
  r.post('/v1/lifecycle/messages/send', { schema: { tags: ['lifecycle'], body: z.object({ profileId: z.string().uuid(), templateId: z.string().uuid(), connectionId: z.string().uuid(), evidenceIds: z.array(z.string().uuid()).default([]) }) } }, async (req, reply) =>
    reply.status(201).send(await lifecycle.sendOneOff(deps, tenantOf(req), actorOf(req), req.body)),
  );
  r.get('/v1/lifecycle/messages', { schema: { tags: ['lifecycle'], querystring: z.object({ profileId: z.string().uuid().optional() }) } }, async (req) => tenantTx(ctx, req, (tx) => lifecycle.listMessages(tx, req.query.profileId)));
  r.get('/v1/lifecycle/report', { schema: { tags: ['lifecycle'], querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) } }, async (req) => tenantTx(ctx, req, (tx) => lifecycle.deliveryReport(tx, new Date(deps.clock.now().getTime() - req.query.days * 86_400_000))));

  /* ---------------- M21 Conversations ---------------- */
  r.post('/v1/conversations/widgets', { schema: { tags: ['conversations'], body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => conversationsModule.createWidget(tx, tenantOf(req), actorOf(req), req.body))));
  r.get('/v1/conversations', { schema: { tags: ['conversations'], querystring: z.object({ status: z.enum(['open', 'handoff', 'closed']).optional() }) } }, async (req) => tenantTx(ctx, req, (tx) => conversationsModule.listConversations(tx, req.query.status)));
  r.get('/v1/conversations/tickets', { schema: { tags: ['conversations'] } }, async (req) => tenantTx(ctx, req, (tx) => conversationsModule.listTickets(tx)));
  r.get('/v1/conversations/leads', { schema: { tags: ['conversations'] } }, async (req) => tenantTx(ctx, req, (tx) => conversationsModule.listLeads(tx)));
  r.post('/v1/conversations/leads/:id/status', { schema: { tags: ['conversations'], params: Id, body: z.object({ status: z.enum(['qualified', 'disqualified', 'handed_off']) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => conversationsModule.setLeadStatus(tx, tenantOf(req), actorOf(req), req.params.id, req.body.status)),
  );
  r.get('/v1/conversations/:id', { schema: { tags: ['conversations'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => conversationsModule.conversationDetail(tx, req.params.id)));
  r.post('/v1/conversations/:id/reply', { schema: { tags: ['conversations'], params: Id, body: z.object({ text: z.string().min(1).max(4000) }) } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => conversationsModule.humanReply(tx, tenantOf(req), actorOf(req), req.params.id, req.body.text))),
  );
  r.post('/v1/conversations/:id/close', { schema: { tags: ['conversations'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => conversationsModule.closeConversation(tx, tenantOf(req), actorOf(req), req.params.id)));

  /* ---------------- M22 Creators ---------------- */
  r.get('/v1/creators', { schema: { tags: ['creators'] } }, async (req) => tenantTx(ctx, req, (tx) => creatorsModule.listCreators(tx)));
  r.post('/v1/creators', { schema: { tags: ['creators'], body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => creatorsModule.createCreator(tx, tenantOf(req), actorOf(req), req.body))));
  r.get('/v1/creators/fraud-flags', { schema: { tags: ['creators'], querystring: z.object({ status: z.enum(['open', 'dismissed', 'confirmed']).default('open') }) } }, async (req) => tenantTx(ctx, req, (tx) => creatorsModule.listFraudFlags(tx, req.query.status)));
  r.post('/v1/creators/fraud-flags/:id', { schema: { tags: ['creators'], params: Id, body: z.object({ status: z.enum(['dismissed', 'confirmed']) }) } }, async (req) => tenantTx(ctx, req, (tx) => creatorsModule.resolveFraudFlag(tx, tenantOf(req), actorOf(req), req.params.id, req.body.status)));
  r.post('/v1/creators/contracts', { schema: { tags: ['creators'], body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => creatorsModule.createContract(tx, tenantOf(req), actorOf(req), req.body))));
  r.post('/v1/creators/links', { schema: { tags: ['creators'], body: z.object({ creatorId: z.string().uuid(), contractId: z.string().uuid(), destinationUrl: z.string().url() }) } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => creatorsModule.createReferralLink(tx, tenantOf(req), actorOf(req), req.body))),
  );
  r.post('/v1/creators/submissions', { schema: { tags: ['creators'], body: z.object({ creatorId: z.string().uuid(), contractId: z.string().uuid(), contentUrl: z.string().url().nullable().default(null), contentText: z.string().min(1).max(20_000) }) } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => creatorsModule.submitContent(tx, tenantOf(req), actorOf(req), req.body))),
  );
  r.post('/v1/creators/submissions/:id/review', { schema: { tags: ['creators'], params: Id, body: z.object({ decision: z.enum(['approved', 'rejected']) }) } }, async (req) => tenantTx(ctx, req, (tx) => creatorsModule.reviewSubmission(tx, tenantOf(req), actorOf(req), req.params.id, req.body.decision)));
  r.get('/v1/creators/:id', { schema: { tags: ['creators'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => creatorsModule.creatorDetail(tx, req.params.id, deps.clock.now())));
  r.get('/v1/creators/:id/payout-readiness', { schema: { tags: ['creators'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => creatorsModule.payouts.payoutReadiness(tx, req.params.id, deps.clock.now())));
  r.put('/v1/creators/:id/payout-profile', { schema: { tags: ['creators'], params: Id, body: Body } }, async (req) => tenantTx(ctx, req, (tx) => creatorsModule.payouts.setPayoutProfile(tx, tenantOf(req), actorOf(req), req.params.id, req.body)));
  r.get('/v1/creators/payout-requests', { schema: { tags: ['creators'] } }, async (req) => tenantTx(ctx, req, (tx) => creatorsModule.payouts.listPayoutRequests(tx)));
  r.get('/v1/creators/payouts/overview', { schema: { tags: ['creators'] } }, async (req) => tenantTx(ctx, req, (tx) => creatorsModule.payouts.payoutsOverview(tx, actorOf(req), deps.clock.now())));
  r.get('/v1/creators/:id/ledger', { schema: { tags: ['creators'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => creatorsModule.payouts.creatorLedger(tx, actorOf(req), req.params.id)));
  r.post('/v1/creators/payout-requests/:id/dispute', { schema: { tags: ['creators'], params: Id, body: z.object({ reason: z.string().min(5).max(1000) }) } }, async (req) => tenantTx(ctx, req, (tx) => creatorsModule.payouts.recordPayoutDispute(tx, tenantOf(req), actorOf(req), req.params.id, req.body.reason)));
  r.post('/v1/creators/:id/payout', { schema: { tags: ['creators'], params: Id } }, async (req, reply) => reply.status(201).send(await creatorsModule.proposePayout(deps, tenantOf(req), actorOf(req), req.params.id)));
}
