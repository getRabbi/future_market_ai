import { contentStudio } from '@futuregrow/core';
import { connections } from '@futuregrow/db';
import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type ApiContext, actorOf, tenantOf, tenantTx } from '../http.js';

const Id = z.object({ id: z.string().uuid() });
const Body = z.record(z.string(), z.unknown());

/** Content studio (D-040): curriculum programs, the seven-day calendar, card previews and the community workspace. */
export function registerContentRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = ctx;

  r.get('/v1/content/packs', { schema: { tags: ['content'] } }, async () =>
    Object.values(contentStudio.PACKS).map((p) => ({
      id: p.id,
      title: p.title,
      version: contentStudio.packVersion(p),
      units: contentStudio.packUnits(p).length,
      vocabulary: p.vocab.length,
      letters: p.letters.length,
      grammar: p.grammar.length,
      mistakes: p.mistakes.length,
      dialogues: p.dialogues.length,
      readings: p.readings.length,
    })),
  );
  r.get('/v1/content/programs', { schema: { tags: ['content'] } }, async (req) => tenantTx(ctx, req, (tx) => contentStudio.listPrograms(tx)));
  r.put('/v1/content/programs', { schema: { tags: ['content'], body: Body } }, async (req) => tenantTx(ctx, req, (tx) => contentStudio.upsertProgram(tx, tenantOf(req), actorOf(req), req.body)));
  r.get('/v1/content/programs/:id/overview', { schema: { tags: ['content'], params: Id } }, async (req) => contentStudio.overview(deps, tenantOf(req), req.params.id));
  r.get('/v1/content/plan-items/:id/preview', { schema: { tags: ['content'], params: Id } }, async (req) => {
    const p = await contentStudio.previewPlanItem(deps, tenantOf(req), req.params.id);
    return { stored: p.stored, caption: p.caption, qa: p.qa, checks: p.checks, image: `data:image/png;base64,${Buffer.from(p.png).toString('base64')}` };
  });

  /* ---------------- Community workspace (owner-assisted; nothing is posted to groups) ---------------- */
  r.get('/v1/content/community/groups', { schema: { tags: ['content'] } }, async (req) => tenantTx(ctx, req, (tx) => contentStudio.listGroups(tx)));
  r.post('/v1/content/community/groups', { schema: { tags: ['content'], body: Body } }, async (req, reply) => reply.status(201).send(await tenantTx(ctx, req, (tx) => contentStudio.addGroup(tx, tenantOf(req), actorOf(req), req.body))));
  r.patch('/v1/content/community/groups/:id', { schema: { tags: ['content'], params: Id, body: Body } }, async (req) => tenantTx(ctx, req, (tx) => contentStudio.updateGroup(tx, tenantOf(req), actorOf(req), req.params.id, req.body)));
  r.post('/v1/content/community/groups/:id/share-kit', { schema: { tags: ['content'], params: Id, body: z.object({ planItemId: z.string().uuid().nullable().default(null) }).strict() } }, async (req, reply) =>
    reply.status(201).send(
      await tenantTx(ctx, req, async (tx) => {
        const programs = await contentStudio.listPrograms(tx);
        const pages = programs.length
          ? await tx
              .select({ name: connections.displayName })
              .from(connections)
              .where(
                inArray(
                  connections.id,
                  programs.map((p) => p.connectionId),
                ),
              )
          : [];
        return contentStudio.prepareShare(tx, deps, tenantOf(req), actorOf(req), req.params.id, { planItemId: req.body.planItemId, pageName: pages[0]?.name ?? 'our Page' });
      }),
    ),
  );
  r.get('/v1/content/community/shares', { schema: { tags: ['content'] } }, async (req) => tenantTx(ctx, req, (tx) => contentStudio.listShares(tx)));
  r.post('/v1/content/community/shares/:id/confirm', { schema: { tags: ['content'], params: Id, body: Body } }, async (req) => tenantTx(ctx, req, (tx) => contentStudio.confirmShare(tx, tenantOf(req), actorOf(req), req.params.id, req.body)));
}
