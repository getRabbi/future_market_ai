import { brandsModule, media } from '@futuregrow/core';
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
