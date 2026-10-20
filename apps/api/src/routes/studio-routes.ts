import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { assetsModule, creative, offersModule, personas } from '@futuregrow/core';
import { FgError } from '@futuregrow/observability';
import { z } from 'zod';
import { type ApiContext, actorOf, tenantOf, tenantTx } from '../http.js';

const Id = z.object({ id: z.string().uuid() });
const Body = z.record(z.string(), z.unknown());
const MAX_UPLOAD_BYTES = Number(process.env.FG_MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024);

/** Routes for M12–M15: offers/CRO, creative briefs, assets/renders, synthetic personas. */
export function registerStudioRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = ctx;

  app.addContentTypeParser(['application/octet-stream', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'audio/mpeg'], { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));

  /* ---------------- M12 ---------------- */
  r.get('/v1/offers', { schema: { tags: ['offers'] } }, async (req) => tenantTx(ctx, req, (tx) => offersModule.listOffers(tx)));
  r.get('/v1/offers/guardrails', { schema: { tags: ['offers'] } }, async (req) => tenantTx(ctx, req, (tx) => offersModule.listGuardrails(tx)));
  r.put('/v1/offers/guardrails', { schema: { tags: ['offers'], body: Body } }, async (req) => tenantTx(ctx, req, (tx) => offersModule.setGuardrail(tx, tenantOf(req), actorOf(req), req.body)));
  r.post('/v1/offers', { schema: { tags: ['offers'], body: Body } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => offersModule.createOffer(tx, deps, tenantOf(req), actorOf(req), req.body))),
  );
  r.post('/v1/offers/:id/approve', { schema: { tags: ['offers'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => offersModule.approveOffer(tx, tenantOf(req), actorOf(req), req.params.id)));
  r.post(
    '/v1/offers/:id/launch-shopify',
    { schema: { tags: ['offers'], params: Id, body: z.object({ connectionId: z.string().uuid(), geographies: z.array(z.string().min(2)).min(1), evidenceIds: z.array(z.string().uuid()).default([]) }) } },
    async (req, reply) => reply.status(201).send(await offersModule.proposeShopifyDiscount(deps, tenantOf(req), actorOf(req), req.params.id, req.body)),
  );
  r.get('/v1/offers/cro', { schema: { tags: ['offers'] } }, async (req) => tenantTx(ctx, req, (tx) => offersModule.listCro(tx)));
  r.post('/v1/offers/cro', { schema: { tags: ['offers'], body: Body } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => offersModule.createCroHypothesis(tx, tenantOf(req), actorOf(req), req.body))),
  );

  /* ---------------- M13 ---------------- */
  r.get('/v1/creative/briefs', { schema: { tags: ['creative'] } }, async (req) => tenantTx(ctx, req, (tx) => creative.listBriefs(tx)));
  r.post('/v1/creative/briefs', { schema: { tags: ['creative'], body: Body } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => creative.createBrief(tx, deps, tenantOf(req), actorOf(req), req.body))),
  );
  r.post(
    '/v1/creative/briefs/generate',
    { schema: { tags: ['creative'], body: z.object({ objective: z.string().min(3), channel: z.enum(creative.CHANNELS), audience: z.string().min(3), ideaId: z.string().uuid().optional() }) } },
    async (req, reply) => reply.status(202).send(await creative.generateBrief(deps, tenantOf(req), actorOf(req), req.body)),
  );
  r.post('/v1/creative/briefs/:id/approve', { schema: { tags: ['creative'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => creative.approveBrief(tx, tenantOf(req), actorOf(req), req.params.id)));

  /* ---------------- M14 ---------------- */
  r.get('/v1/assets', { schema: { tags: ['assets'] } }, async (req) => tenantTx(ctx, req, (tx) => assetsModule.listAssets(tx)));
  r.get('/v1/assets/:id', { schema: { tags: ['assets'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => assetsModule.assetDetail(tx, req.params.id)));
  app.post('/v1/assets/upload', async (req, reply) => {
    const raw = req.headers['x-fg-asset-meta'];
    if (typeof raw !== 'string') throw new FgError('INVALID', 'x-fg-asset-meta header (JSON) is required', 422);
    let meta: unknown;
    try {
      meta = JSON.parse(decodeURIComponent(raw));
    } catch {
      throw new FgError('INVALID', 'x-fg-asset-meta must be URI-encoded JSON', 422);
    }
    const body = req.body;
    if (!(body instanceof Buffer)) throw new FgError('INVALID', 'binary body required', 422);
    const row = await tenantTx(ctx, req, (tx) => assetsModule.uploadAsset(tx, deps, tenantOf(req), actorOf(req), meta, new Uint8Array(body)));
    return reply.status(201).send(row);
  });
  r.post('/v1/assets/:id/rights', { schema: { tags: ['assets'], params: Id, body: z.object({ components: z.array(z.unknown()).min(1) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => assetsModule.addRights(tx, deps, tenantOf(req), actorOf(req), req.params.id, req.body.components)),
  );
  r.get('/v1/assets/:id/download-url', { schema: { tags: ['assets'], params: Id } }, async (req) => {
    const { asset } = await tenantTx(ctx, req, (tx) => assetsModule.assetDetail(tx, req.params.id));
    return { url: await deps.store.presign(asset.objectKey, 'GET', 900), expiresInSeconds: 900 };
  });
  r.get('/v1/assets/renders', { schema: { tags: ['assets'] } }, async (req) => tenantTx(ctx, req, (tx) => assetsModule.listRenderJobs(tx)));
  r.post('/v1/assets/renders', { schema: { tags: ['assets'], body: Body } }, async (req, reply) =>
    reply.status(202).send(await tenantTx(ctx, req, (tx) => assetsModule.requestRender(tx, deps, tenantOf(req), actorOf(req), req.body))),
  );
  r.put('/v1/assets/remotion-license', { schema: { tags: ['assets'], body: Body } }, async (req) => tenantTx(ctx, req, (tx) => assetsModule.recordRemotionLicense(tx, tenantOf(req), actorOf(req), req.body)));

  /* ---------------- M15 ---------------- */
  r.get('/v1/personas', { schema: { tags: ['personas'] } }, async (req) => tenantTx(ctx, req, (tx) => personas.listPersonas(tx)));
  r.post('/v1/personas', { schema: { tags: ['personas'], body: Body } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => personas.createPersona(tx, tenantOf(req), actorOf(req), req.body))),
  );
  r.post('/v1/personas/:id/approve', { schema: { tags: ['personas'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => personas.approvePersona(tx, tenantOf(req), actorOf(req), req.params.id)));
  r.post('/v1/personas/:id/suspend', { schema: { tags: ['personas'], params: Id, body: z.object({ reason: z.string().min(3) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => personas.suspendPersona(tx, tenantOf(req), actorOf(req), req.params.id, req.body.reason)),
  );
  r.post('/v1/personas/protected-identities', { schema: { tags: ['personas'], body: z.object({ name: z.string().min(2), reason: z.string().min(3) }) } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => personas.addProtectedIdentity(tx, tenantOf(req), actorOf(req), req.body))),
  );
}
