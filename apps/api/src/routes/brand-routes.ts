import { brandsModule } from '@futuregrow/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type ApiContext, actorOf, tenantOf, tenantTx } from '../http.js';

const Id = z.object({ id: z.string().uuid() });
const Body = z.record(z.string(), z.unknown());

/** Brands (D-041): profiles plus explicit channel-account, application and program mappings. */
export function registerBrandRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

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
