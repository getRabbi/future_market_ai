import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { appGrowth, conversationsModule, creatorsModule, discovery, lifecycle, paidMedia, social } from '@futuregrow/core';
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

  /* ---------------- M16 Organic social ---------------- */
  r.get('/v1/social/posts', { schema: { tags: ['social'] } }, async (req) => tenantTx(ctx, req, (tx) => social.listPosts(tx)));
  r.post('/v1/social/posts', { schema: { tags: ['social'], body: Body } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => social.schedulePost(tx, deps, tenantOf(req), actorOf(req), req.body))),
  );
  r.get('/v1/social/stats', { schema: { tags: ['social'] } }, async (req) => tenantTx(ctx, req, (tx) => social.audienceStats(tx)));
  r.get('/v1/social/interactions', { schema: { tags: ['social'] } }, async (req) => tenantTx(ctx, req, (tx) => social.listInteractions(tx)));
  r.post('/v1/social/interactions/:id/draft-reply', { schema: { tags: ['social'], params: Id } }, async (req, reply) =>
    reply.status(202).send(await social.draftReply(deps, tenantOf(req), actorOf(req), req.params.id)),
  );
  r.post('/v1/social/interactions/:id/reply', { schema: { tags: ['social'], params: Id, body: z.object({ message: z.string().min(1).max(8000).optional(), geographies: Geos }) } }, async (req, reply) =>
    reply.status(201).send(await social.proposeReply(deps, tenantOf(req), actorOf(req), req.params.id, req.body)),
  );

  /* ---------------- M17 Paid media ---------------- */
  r.get('/v1/ads/campaigns', { schema: { tags: ['ads'] } }, async (req) => tenantTx(ctx, req, (tx) => paidMedia.listCampaigns(tx)));
  r.get('/v1/ads/campaigns/:id/performance', { schema: { tags: ['ads'], params: Id, querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => paidMedia.campaignPerformance(tx, req.params.id, req.query.days)),
  );
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
  r.get('/v1/ads/reconciliations', { schema: { tags: ['ads'] } }, async (req) => tenantTx(ctx, req, (tx) => paidMedia.listReconciliations(tx)));
  r.post('/v1/ads/campaigns/:id/budget', { schema: { tags: ['ads'], params: Id, body: Body } }, async (req, reply) =>
    reply.status(201).send(await paidMedia.proposeBudgetChange(deps, tenantOf(req), actorOf(req), req.params.id, req.body)),
  );
  r.post(
    '/v1/ads/campaigns/:id/status',
    { schema: { tags: ['ads'], params: Id, body: z.object({ status: z.enum(['PAUSED', 'ACTIVE']), geographies: Geos, evidenceIds: z.array(z.string().uuid()).default([]), rationale: z.string().min(10).max(2000) }) } },
    async (req, reply) => reply.status(201).send(await paidMedia.proposeStatusChange(deps, tenantOf(req), actorOf(req), req.params.id, req.body)),
  );

  /* ---------------- M18 SEO / ASO / AI discovery ---------------- */
  r.get('/v1/seo/audits', { schema: { tags: ['seo'] } }, async (req) => tenantTx(ctx, req, (tx) => discovery.listAudits(tx)));
  r.post('/v1/seo/audits', { schema: { tags: ['seo'], body: Body } }, async (req, reply) =>
    reply.status(202).send(await tenantTx(ctx, req, (tx) => discovery.requestSeoAudit(tx, deps, tenantOf(req), actorOf(req), req.body))),
  );
  r.get('/v1/seo/audits/:id', { schema: { tags: ['seo'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => discovery.auditDetail(tx, req.params.id)));
  r.post('/v1/seo/keywords/upload', { schema: { tags: ['seo'], body: Body } }, async (req) => tenantTx(ctx, req, (tx) => discovery.uploadKeywordMetrics(tx, tenantOf(req), actorOf(req), req.body)));
  r.post('/v1/seo/search-console/sync', { schema: { tags: ['seo'], body: z.object({ connectionId: z.string().uuid(), siteUrl: z.string().min(4), startDate: Day, endDate: Day }) } }, async (req) => {
    paidMedia.requireOperator(actorOf(req));
    return discovery.syncSearchConsole(deps, tenantOf(req), req.body.connectionId, req.body);
  });
  r.get('/v1/seo/opportunities', { schema: { tags: ['seo'], querystring: z.object({ minImpressions: z.coerce.number().int().min(1).default(100) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => discovery.keywordOpportunities(tx, { minImpressions: req.query.minImpressions })),
  );
  r.post('/v1/aso/validate', { schema: { tags: ['aso'], body: z.object({ store: z.enum(['app_store', 'google_play']), fields: z.record(z.string(), z.string()) }) } }, async (req) => ({
    checks: discovery.validateListingFields(req.body.store, req.body.fields),
    limits: discovery.STORE_LIMITS[req.body.store],
  }));
  r.get('/v1/aso/listings', { schema: { tags: ['aso'] } }, async (req) => tenantTx(ctx, req, (tx) => discovery.listListings(tx)));
  r.post('/v1/aso/listings', { schema: { tags: ['aso'], body: Body } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => discovery.createListingDraft(tx, deps, tenantOf(req), actorOf(req), req.body))),
  );
  r.post('/v1/aso/listings/:id/approve', { schema: { tags: ['aso'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => discovery.approveListing(tx, tenantOf(req), actorOf(req), req.params.id)));
  r.post(
    '/v1/aso/listings/:id/push',
    { schema: { tags: ['aso'], params: Id, body: z.object({ connectionId: z.string().uuid(), localizationId: z.string().min(1), geographies: Geos, evidenceIds: z.array(z.string().uuid()).default([]) }) } },
    async (req, reply) => reply.status(201).send(await discovery.proposeAppStoreUpdate(deps, tenantOf(req), actorOf(req), req.params.id, req.body)),
  );

  /* ---------------- M19 App growth ---------------- */
  r.get('/v1/app/installs/stats', { schema: { tags: ['app'] } }, async (req) => tenantTx(ctx, req, (tx) => appGrowth.installStats(tx)));
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
  r.post('/v1/lifecycle/templates', { schema: { tags: ['lifecycle'], body: Body } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => lifecycle.createTemplate(tx, deps, tenantOf(req), actorOf(req), req.body))),
  );
  r.post('/v1/lifecycle/templates/:id/approve', { schema: { tags: ['lifecycle'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => lifecycle.approveTemplate(tx, deps, tenantOf(req), actorOf(req), req.params.id)));
  r.get('/v1/lifecycle/journeys', { schema: { tags: ['lifecycle'] } }, async (req) => tenantTx(ctx, req, (tx) => lifecycle.listJourneys(tx)));
  r.post('/v1/lifecycle/journeys', { schema: { tags: ['lifecycle'], body: Body } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => lifecycle.createJourney(tx, tenantOf(req), actorOf(req), req.body))),
  );
  r.post('/v1/lifecycle/journeys/:id/activate', { schema: { tags: ['lifecycle'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => lifecycle.activateJourney(tx, tenantOf(req), actorOf(req), req.params.id)));
  r.post('/v1/lifecycle/journeys/:id/pause', { schema: { tags: ['lifecycle'], params: Id, body: z.object({ reason: z.string().min(3) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => lifecycle.pauseJourney(tx, tenantOf(req), actorOf(req), req.params.id, req.body.reason)),
  );
  r.get('/v1/lifecycle/journeys/:id/stats', { schema: { tags: ['lifecycle'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => lifecycle.journeyStats(tx, req.params.id)));
  r.post(
    '/v1/lifecycle/messages/send',
    { schema: { tags: ['lifecycle'], body: z.object({ profileId: z.string().uuid(), templateId: z.string().uuid(), connectionId: z.string().uuid(), evidenceIds: z.array(z.string().uuid()).default([]) }) } },
    async (req, reply) => reply.status(201).send(await lifecycle.sendOneOff(deps, tenantOf(req), actorOf(req), req.body)),
  );
  r.get('/v1/lifecycle/messages', { schema: { tags: ['lifecycle'], querystring: z.object({ profileId: z.string().uuid().optional() }) } }, async (req) => tenantTx(ctx, req, (tx) => lifecycle.listMessages(tx, req.query.profileId)));
  r.get('/v1/lifecycle/report', { schema: { tags: ['lifecycle'], querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => lifecycle.deliveryReport(tx, new Date(deps.clock.now().getTime() - req.query.days * 86_400_000))),
  );

  /* ---------------- M21 Conversations ---------------- */
  r.post('/v1/conversations/widgets', { schema: { tags: ['conversations'], body: Body } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => conversationsModule.createWidget(tx, tenantOf(req), actorOf(req), req.body))),
  );
  r.get('/v1/conversations', { schema: { tags: ['conversations'], querystring: z.object({ status: z.enum(['open', 'handoff', 'closed']).optional() }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => conversationsModule.listConversations(tx, req.query.status)),
  );
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
  r.post('/v1/creators', { schema: { tags: ['creators'], body: Body } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => creatorsModule.createCreator(tx, tenantOf(req), actorOf(req), req.body))),
  );
  r.get('/v1/creators/fraud-flags', { schema: { tags: ['creators'], querystring: z.object({ status: z.enum(['open', 'dismissed', 'confirmed']).default('open') }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => creatorsModule.listFraudFlags(tx, req.query.status)),
  );
  r.post('/v1/creators/fraud-flags/:id', { schema: { tags: ['creators'], params: Id, body: z.object({ status: z.enum(['dismissed', 'confirmed']) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => creatorsModule.resolveFraudFlag(tx, tenantOf(req), actorOf(req), req.params.id, req.body.status)),
  );
  r.post('/v1/creators/contracts', { schema: { tags: ['creators'], body: Body } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => creatorsModule.createContract(tx, tenantOf(req), actorOf(req), req.body))),
  );
  r.post('/v1/creators/links', { schema: { tags: ['creators'], body: z.object({ creatorId: z.string().uuid(), contractId: z.string().uuid(), destinationUrl: z.string().url() }) } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => creatorsModule.createReferralLink(tx, tenantOf(req), actorOf(req), req.body))),
  );
  r.post(
    '/v1/creators/submissions',
    { schema: { tags: ['creators'], body: z.object({ creatorId: z.string().uuid(), contractId: z.string().uuid(), contentUrl: z.string().url().nullable().default(null), contentText: z.string().min(1).max(20_000) }) } },
    async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => creatorsModule.submitContent(tx, tenantOf(req), actorOf(req), req.body))),
  );
  r.post('/v1/creators/submissions/:id/review', { schema: { tags: ['creators'], params: Id, body: z.object({ decision: z.enum(['approved', 'rejected']) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => creatorsModule.reviewSubmission(tx, tenantOf(req), actorOf(req), req.params.id, req.body.decision)),
  );
  r.get('/v1/creators/:id', { schema: { tags: ['creators'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => creatorsModule.creatorDetail(tx, req.params.id, deps.clock.now())));
  r.post('/v1/creators/:id/payout', { schema: { tags: ['creators'], params: Id } }, async (req, reply) =>
    reply.status(201).send(await creatorsModule.proposePayout(deps, tenantOf(req), actorOf(req), req.params.id)),
  );
}
