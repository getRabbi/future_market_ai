import { brandsModule, media } from '@futuregrow/core';
import { FgError } from '@futuregrow/observability';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type ApiContext, actorOf, tenantOf, tenantTx } from '../http.js';

const Id = z.object({ id: z.string().uuid() });
const Body = z.record(z.string(), z.unknown());

/** Brands (D-041): profiles plus explicit channel-account, application and program mappings. */
export function registerBrandRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/media/providers', { schema: { tags: ['brands'] } }, async (req) => tenantTx(ctx, req, (t) => media.mediaProviders({ t, deps: ctx.deps, tenantId: tenantOf(req) })));
  /* Licensed stock (P3-03) and AI images (P3-02): queued media jobs; results are assets with rights and provenance. */
  const S = media.sources;
  /* AI voiceover (P3-04): readiness (no provider call) and a queued job; disabled until a speech model is approved and priced. */
  r.get('/v1/media/voice', { schema: { tags: ['assets'] } }, async (req) => tenantTx(ctx, req, (t) => media.voice.speechReadiness(t, ctx.deps)));
  r.post('/v1/media/voiceovers', { schema: { tags: ['assets'], body: Body } }, async (req, reply) => reply.status(202).send(await tenantTx(ctx, req, (tx) => media.voice.requestVoiceover(tx, ctx.deps, tenantOf(req), actorOf(req), req.body))));
  r.get('/v1/media/generative-video/readiness', { schema: { tags: ['assets'] } }, async (req) => tenantTx(ctx, req, (tx) => media.generativeVideo.generativeVideoReadiness(tx, ctx.deps)));
  r.post('/v1/media/generative-video', { schema: { tags: ['assets'], body: media.generativeVideo.GenerativeVideoRequest } }, async (req, reply) => reply.status(202).send(await tenantTx(ctx, req, (tx) => media.generativeVideo.requestGenerativeVideo(tx, ctx.deps, tenantOf(req), actorOf(req), req.body))));
  /* Video switchboard: four independent modes, persistent switches, Smart routing, paid budgets. */
  const VR = media.videoRouting;
  const VJ = media.videoJobs;
  const GV = media.generativeVideo;
  r.get('/v1/media/video-routing', { schema: { tags: ['assets'] } }, async (req) => tenantTx(ctx, req, (tx) => VR.videoRoutingOverview(tx, ctx.deps, tenantOf(req))));
  r.put('/v1/media/video-routing', { schema: { tags: ['assets'], body: VR.VideoRoutingUpdateSchema } }, async (req) => tenantTx(ctx, req, (tx) => VR.updateVideoRouting(tx, ctx.deps, tenantOf(req), actorOf(req), req.body)));
  r.get('/v1/media/video-routing/readiness', { schema: { tags: ['assets'] } }, async (req) => tenantTx(ctx, req, async (tx) => (await VR.videoRoutingOverview(tx, ctx.deps, tenantOf(req))).modes));
  r.post('/v1/media/video-routing/preview', { schema: { tags: ['assets'], body: VR.VideoRouteRequestSchema } }, async (req) => tenantTx(ctx, req, (tx) => VR.previewVideoRoute(tx, ctx.deps, tenantOf(req), req.body)));
  r.post('/v1/media/video-routing/estimate', { schema: { tags: ['assets'], body: VR.VideoRouteRequestSchema } }, async (req) =>
    tenantTx(ctx, req, async (tx) => {
      const d = await VR.previewVideoRoute(tx, ctx.deps, tenantOf(req), req.body);
      return { mode: d.mode, execution: d.execution, estimateUsd: d.estimateUsd, candidates: d.candidates.map((c) => ({ mode: c.mode, estimateUsd: c.estimateUsd, eligible: c.eligible })), usage: d.usage };
    }),
  );
  r.get('/v1/media/video-routing/daily-plan', { schema: { tags: ['assets'] } }, async (req) => tenantTx(ctx, req, (tx) => VJ.dailyVideoPlan(tx, ctx.deps, tenantOf(req))));
  /* Daily Video Automation (D-053): topic → script → storyboard → route → render → review. Never publishes or spends. */
  const VA = media.videoAutomation;
  r.get('/v1/media/video-automation', { schema: { tags: ['assets'] } }, async (req) => tenantTx(ctx, req, (tx) => VA.automationOverview(tx, ctx.deps, tenantOf(req))));
  r.put('/v1/media/video-automation/settings', { schema: { tags: ['assets'], body: VA.AutomationSettingsUpdateSchema } }, async (req) => tenantTx(ctx, req, (tx) => VA.updateAutomationSettings(tx, ctx.deps, tenantOf(req), actorOf(req), req.body)));
  r.post('/v1/media/video-automation/run', { schema: { tags: ['assets'] } }, async (req) => VA.runVideoAutomationNow(ctx.deps, tenantOf(req), actorOf(req)));
  r.post('/v1/media/video-automation/items/:id/retry', { schema: { tags: ['assets'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => VA.retryAutomationItem(tx, ctx.deps, tenantOf(req), actorOf(req), req.params.id)));
  r.post('/v1/media/video-automation/items/:id/review', { schema: { tags: ['assets'], params: Id, body: VA.ReviewSchema } }, async (req) => tenantTx(ctx, req, (tx) => VA.reviewAutomationItem(tx, ctx.deps, tenantOf(req), actorOf(req), req.params.id, req.body)));
  r.get('/v1/media/video-generations', { schema: { tags: ['assets'] } }, async (req) => tenantTx(ctx, req, (tx) => VJ.videoJobHistory(tx, ctx.deps, tenantOf(req))));
  r.post('/v1/media/video-generations', { schema: { tags: ['assets'], body: VJ.VideoGenerationQueueSchema } }, async (req, reply) => reply.status(202).send(await tenantTx(ctx, req, (tx) => VJ.queueVideoGeneration(tx, ctx.deps, tenantOf(req), actorOf(req), req.body))));
  r.post('/v1/media/video-generations/:id/approve', { schema: { tags: ['assets'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => GV.approveVideoGeneration(tx, ctx.deps, tenantOf(req), actorOf(req), req.params.id)));
  r.post('/v1/media/video-generations/:id/cancel', { schema: { tags: ['assets'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => GV.cancelVideoGeneration(tx, ctx.deps, tenantOf(req), actorOf(req), req.params.id)));
  r.post('/v1/media/video-generations/:id/reconcile', { schema: { tags: ['assets'], params: Id, body: GV.ReconcileSchema } }, async (req) => tenantTx(ctx, req, (tx) => GV.reconcileVideoCharge(tx, ctx.deps, tenantOf(req), actorOf(req), req.params.id, req.body)));
  /* Google Flow (manual): the owner uploads the MP4 they generated in Flow; the worker runs QA and stores the asset. */
  app.post('/v1/media/google-flow/import', async (req, reply) => {
    const raw = req.headers['x-fg-asset-meta'];
    if (typeof raw !== 'string') throw new FgError('INVALID', 'x-fg-asset-meta header (JSON) is required', 422);
    let meta: unknown;
    try {
      meta = JSON.parse(decodeURIComponent(raw));
    } catch {
      throw new FgError('INVALID', 'x-fg-asset-meta must be URI-encoded JSON', 422);
    }
    const body = req.body;
    if (!(body instanceof Buffer)) throw new FgError('INVALID', 'binary MP4 body required', 422);
    const out = await tenantTx(ctx, req, (tx) => media.flowImport.requestFlowImport(tx, ctx.deps, tenantOf(req), actorOf(req), meta, new Uint8Array(body)));
    return reply.status(out.duplicate ? 200 : 202).send(out);
  });
  r.post('/v1/media/stock/search', { schema: { tags: ['assets'], body: Body } }, async (req) => S.searchStock(ctx.deps, tenantOf(req), actorOf(req), req.body));
  r.post('/v1/media/stock/import', { schema: { tags: ['assets'], body: Body } }, async (req, reply) => reply.status(202).send(await tenantTx(ctx, req, (tx) => S.requestStockImport(tx, tenantOf(req), actorOf(req), req.body))));
  r.get('/v1/media/stock/assets', { schema: { tags: ['assets'] } }, async (req) => tenantTx(ctx, req, (tx) => S.listStockAssets(tx)));
  r.post('/v1/media/stock/assets/:id/revoke', { schema: { tags: ['assets'], params: Id, body: z.object({ reason: z.string().min(3).max(500) }) } }, async (req) => tenantTx(ctx, req, (tx) => S.revokeStockAsset(tx, ctx.deps, tenantOf(req), actorOf(req), req.params.id, req.body.reason)));
  r.post('/v1/media/images/generate', { schema: { tags: ['assets'], body: Body } }, async (req, reply) => reply.status(202).send(await tenantTx(ctx, req, (tx) => S.requestImageGeneration(tx, ctx.deps, tenantOf(req), actorOf(req), req.body))));
  r.get('/v1/media/jobs', { schema: { tags: ['assets'] } }, async (req) => tenantTx(ctx, req, (tx) => S.listMediaJobs(tx)));
  /* Video Studio (P3-04): storyboard → render (Remotion media job) → QA → MP4, thumbnail and SRT. */
  const V = media.video;
  r.get('/v1/media/videos', { schema: { tags: ['assets'] } }, async (req) => tenantTx(ctx, req, (tx) => V.listVideoProjects(tx)));
  r.post('/v1/media/videos', { schema: { tags: ['assets'], body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => V.createVideoProject(tx, ctx.deps, tenantOf(req), actorOf(req), req.body))));
  r.get('/v1/media/videos/:id', { schema: { tags: ['assets'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => V.videoProject(tx, tenantOf(req), req.params.id)));
  r.put('/v1/media/videos/:id/storyboard', { schema: { tags: ['assets'], params: Id, body: z.object({ storyboard: Body, expectedVersion: z.number().int().min(1), title: z.string().min(1).max(200).optional() }).strict() } }, async (req) =>
    tenantTx(ctx, req, (tx) => V.updateStoryboard(tx, ctx.deps, tenantOf(req), actorOf(req), req.params.id, req.body)),
  );
  r.post('/v1/media/videos/:id/render', { schema: { tags: ['assets'], params: Id } }, async (req, reply) => reply.status(202).send(await tenantTx(ctx, req, (tx) => V.renderVideoProject(tx, ctx.deps, tenantOf(req), actorOf(req), req.params.id))));
  r.get('/v1/media/jobs/:id', { schema: { tags: ['assets'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => S.mediaJob(tx, req.params.id)));
  r.get('/v1/brands', { schema: { tags: ['brands'] } }, async (req) => tenantTx(ctx, req, (tx) => brandsModule.listBrands(tx)));
  r.post('/v1/brands', { schema: { tags: ['brands'], body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => brandsModule.createBrand(tx, tenantOf(req), actorOf(req), req.body))));
  r.get('/v1/brands/:id', { schema: { tags: ['brands'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => brandsModule.getBrand(tx, req.params.id)));
  r.patch('/v1/brands/:id', { schema: { tags: ['brands'], params: Id, body: Body } }, async (req) => tenantTx(ctx, req, (tx) => brandsModule.updateBrand(tx, tenantOf(req), actorOf(req), req.params.id, req.body)));
  r.post('/v1/brands/:id/channels', { schema: { tags: ['brands'], params: Id, body: z.object({ connectionId: z.string().uuid() }).strict() } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => brandsModule.bindChannel(tx, tenantOf(req), actorOf(req), req.params.id, req.body.connectionId))),
  );
  r.delete('/v1/brands/:id/channels/:connectionId', { schema: { tags: ['brands'], params: z.object({ id: z.string().uuid(), connectionId: z.string().uuid() }) } }, async (req) => tenantTx(ctx, req, (tx) => brandsModule.unbindChannel(tx, tenantOf(req), actorOf(req), req.params.id, req.params.connectionId)));
  r.post('/v1/brands/:id/apps', { schema: { tags: ['brands'], params: Id, body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => brandsModule.bindApp(tx, tenantOf(req), actorOf(req), req.params.id, req.body))));
  r.post('/v1/brands/:id/programs', { schema: { tags: ['brands'], params: Id, body: z.object({ programId: z.string().uuid() }).strict() } }, async (req) => tenantTx(ctx, req, (tx) => brandsModule.assignProgram(tx, tenantOf(req), actorOf(req), req.params.id, req.body.programId)));
}
