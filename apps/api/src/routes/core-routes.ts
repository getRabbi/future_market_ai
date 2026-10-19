import { desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { KILL_SWITCH_SCOPES, MODULES, listActionTypes } from '@futuregrow/contracts';
import { connectionsModule, evidence, execution, governance } from '@futuregrow/core';
import { alerts, artifactLicenses, incidents, killSwitches, member, organization, platformCapabilities, withSystem } from '@futuregrow/db';
import { z } from 'zod';
import { type ApiContext, actorOf, tenantOf, tenantTx } from '../http.js';

const Id = z.object({ id: z.string().uuid() });

export function registerCoreRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = ctx;

  /* ---------------- identity ---------------- */
  r.get('/v1/me', { schema: { tags: ['identity'] } }, async (req) => {
    const actor = actorOf(req);
    const memberships = await withSystem(deps.db, `user:${actor.id}`, (tx) =>
      tx
        .select({ organizationId: member.organizationId, role: member.role, name: organization.name, slug: organization.slug })
        .from(member)
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(eq(member.userId, actor.id)),
    );
    return { userId: actor.id, tenantId: tenantOf(req), roles: actor.roles, mfaVerified: actor.mfaVerified, memberships };
  });

  r.get('/v1/modules', { schema: { tags: ['identity'] } }, async () => ({ modules: MODULES }));
  r.get('/v1/action-types', { schema: { tags: ['actions'] } }, async () => ({
    actionTypes: listActionTypes().map(({ paramsSchema: _p, ...rest }) => rest),
  }));

  /* ---------------- governance (M24) ---------------- */
  r.get('/v1/governance/policy', { schema: { tags: ['governance'] } }, async (req) =>
    tenantTx(ctx, req, (tx) => governance.getTenantPolicy(tx, tenantOf(req))),
  );
  r.put('/v1/governance/policy', { schema: { tags: ['governance'], body: z.record(z.string(), z.unknown()) } }, async (req) =>
    tenantTx(ctx, req, (tx) => governance.setTenantPolicy(tx, tenantOf(req), actorOf(req), req.body)),
  );
  r.put(
    '/v1/governance/sender-identity',
    {
      schema: {
        tags: ['governance'],
        body: z.object({ fromName: z.string().min(1), fromEmail: z.string().email(), replyTo: z.string().email().optional(), postalAddress: z.string().min(10) }),
      },
    },
    async (req) => {
      await tenantTx(ctx, req, (tx) => governance.setSenderIdentity(tx, tenantOf(req), actorOf(req), req.body));
      return { ok: true };
    },
  );

  r.get('/v1/governance/kill-switches', { schema: { tags: ['governance'] } }, async (req) =>
    tenantTx(ctx, req, (tx) => tx.select().from(killSwitches).orderBy(desc(killSwitches.engagedAt)).limit(200)),
  );
  r.post(
    '/v1/governance/kill-switches',
    {
      schema: {
        tags: ['governance'],
        body: z.object({
          scope: z.enum(KILL_SWITCH_SCOPES).exclude(['system']),
          targetRef: z.string().min(1).nullable().default(null),
          reason: z.string().min(3).max(2000),
        }),
      },
    },
    async (req, reply) => {
      const res = await tenantTx(ctx, req, (tx) => governance.engageKillSwitch(tx, tenantOf(req), actorOf(req), req.body));
      return reply.status(201).send(res);
    },
  );
  r.post('/v1/governance/kill-switches/:id/release', { schema: { tags: ['governance'], params: Id } }, async (req) =>
    tenantTx(ctx, req, (tx) => governance.releaseKillSwitch(tx, tenantOf(req), actorOf(req), req.params.id)),
  );

  r.get('/v1/governance/incidents', { schema: { tags: ['governance'] } }, async (req) =>
    tenantTx(ctx, req, (tx) => tx.select().from(incidents).orderBy(desc(incidents.openedAt)).limit(200)),
  );
  r.post('/v1/governance/incidents/:id/resolve', { schema: { tags: ['governance'], params: Id, body: z.object({ resolution: z.string().min(3) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => governance.resolveIncident(tx, tenantOf(req), actorOf(req), req.params.id, req.body.resolution)),
  );
  r.get('/v1/governance/alerts', { schema: { tags: ['governance'] } }, async (req) =>
    tenantTx(ctx, req, (tx) => tx.select().from(alerts).where(isNull(alerts.acknowledgedAt)).orderBy(desc(alerts.createdAt)).limit(200)),
  );
  r.post('/v1/governance/alerts/:id/ack', { schema: { tags: ['governance'], params: Id } }, async (req) =>
    tenantTx(ctx, req, (tx) => governance.acknowledgeAlert(tx, actorOf(req), req.params.id)),
  );
  r.get('/v1/governance/audit/verify', { schema: { tags: ['governance'] } }, async (req) =>
    tenantTx(ctx, req, (tx) => governance.verifyTenantAudit(tx, tenantOf(req))),
  );
  r.get('/v1/governance/audit', { schema: { tags: ['governance'], querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }) } }, async (req) =>
    tenantTx(ctx, req, async (tx) => (await tx.execute(sql`select seq, occurred_at, actor_type, actor_id, action, subject_type, subject_id, payload, record_hash from audit_log order by seq desc limit ${req.query.limit}`)).rows),
  );
  r.get('/v1/governance/capabilities', { schema: { tags: ['governance'] } }, async (req) =>
    tenantTx(ctx, req, (tx) => tx.select().from(platformCapabilities).orderBy(platformCapabilities.platform, platformCapabilities.capability)),
  );
  r.get('/v1/governance/models', { schema: { tags: ['governance'] } }, async (req) => tenantTx(ctx, req, (tx) => governance.listModels(tx)));
  r.get('/v1/governance/artifacts', { schema: { tags: ['governance'] } }, async (req) =>
    tenantTx(ctx, req, (tx) => tx.select().from(artifactLicenses).orderBy(desc(artifactLicenses.createdAt))),
  );
  r.post('/v1/governance/artifacts', { schema: { tags: ['governance'], body: z.record(z.string(), z.unknown()) } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => governance.registerArtifact(tx, tenantOf(req), actorOf(req), req.body))),
  );
  r.post('/v1/governance/artifacts/:id/approve', { schema: { tags: ['governance'], params: Id } }, async (req) =>
    tenantTx(ctx, req, (tx) => governance.approveArtifact(tx, tenantOf(req), actorOf(req), req.params.id)),
  );
  r.get('/v1/governance/costs', { schema: { tags: ['governance'], querystring: z.object({ days: z.coerce.number().int().min(1).max(366).default(30) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => governance.costSummary(tx, tenantOf(req), new Date(Date.now() - req.query.days * 86_400_000))),
  );

  // Platform-operator controls (platform admin only; checked inside core).
  r.post('/v1/platform/system-halt', { schema: { tags: ['platform'], body: z.object({ engaged: z.boolean(), reason: z.string().min(3) }) } }, async (req) => {
    await governance.setSystemHalt(deps.db, { userId: actorOf(req).id }, req.body.engaged, req.body.reason);
    return { ok: true };
  });
  r.post(
    '/v1/platform/models/approve',
    {
      schema: {
        tags: ['platform'],
        body: z.object({
          provider: z.string(),
          modelId: z.string(),
          trainingOnCustomerData: z.enum(['no', 'yes', 'unknown']),
          dataRetentionTerms: z.string().min(3),
          inputUsdPerMtok: z.number().nonnegative().nullable(),
          outputUsdPerMtok: z.number().nonnegative().nullable(),
        }),
      },
    },
    async (req) => {
      await governance.approveModel(deps.db, { userId: actorOf(req).id }, req.body);
      return { ok: true };
    },
  );
  r.post(
    '/v1/platform/jurisdiction-rules',
    {
      schema: {
        tags: ['platform'],
        body: z.object({ jurisdiction: z.string().min(2), domain: z.string().min(2), rules: z.record(z.string(), z.unknown()), sourceRefs: z.array(z.string().url()).min(1), approve: z.boolean() }),
      },
    },
    async (req, reply) => reply.status(201).send(await governance.upsertJurisdictionRules(deps.db, { userId: actorOf(req).id }, req.body)),
  );

  /* ---------------- actions (M23) ---------------- */
  r.post('/v1/actions', { schema: { tags: ['actions'], body: z.record(z.string(), z.unknown()) } }, async (req, reply) =>
    reply.status(201).send(await execution.proposeAction(deps, tenantOf(req), actorOf(req), req.body)),
  );
  r.get(
    '/v1/actions',
    { schema: { tags: ['actions'], querystring: z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) } },
    async (req) => tenantTx(ctx, req, (tx) => execution.listActions(tx, { status: req.query.status?.split(','), limit: req.query.limit })),
  );
  r.get('/v1/actions/:id', { schema: { tags: ['actions'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => execution.getActionDetail(tx, req.params.id)));
  r.post(
    '/v1/actions/:id/decision',
    { schema: { tags: ['actions'], params: Id, body: z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().max(2000).optional(), expectedActionHash: z.string().regex(/^[a-f0-9]{64}$/) }) } },
    async (req) => execution.decideApproval(deps, tenantOf(req), actorOf(req), req.params.id, req.body),
  );
  r.post('/v1/actions/:id/cancel', { schema: { tags: ['actions'], params: Id, body: z.object({ reason: z.string().min(3) }) } }, async (req) =>
    execution.cancelAction(deps, tenantOf(req), actorOf(req), req.params.id, req.body.reason),
  );

  /* ---------------- connections ---------------- */
  r.get('/v1/connections', { schema: { tags: ['connections'] } }, async (req) => tenantTx(ctx, req, (tx) => connectionsModule.listConnections(tx)));
  r.post('/v1/connections', { schema: { tags: ['connections'], body: z.record(z.string(), z.unknown()) } }, async (req, reply) =>
    reply.status(201).send(await connectionsModule.createConnection(deps, tenantOf(req), actorOf(req), req.body)),
  );
  r.post(
    '/v1/connections/:id/credentials',
    { schema: { tags: ['connections'], params: Id, body: z.object({ credentials: z.record(z.string(), z.unknown()), credentialsExpireAt: z.string().datetime({ offset: true }).nullable().optional() }) } },
    async (req) => connectionsModule.rotateConnectionCredentials(deps, tenantOf(req), actorOf(req), req.params.id, req.body),
  );
  r.post(
    '/v1/connections/:id/status',
    { schema: { tags: ['connections'], params: Id, body: z.object({ status: z.enum(['active', 'disabled', 'read_only', 'revoked']) }) } },
    async (req) => tenantTx(ctx, req, (tx) => connectionsModule.setConnectionStatus(tx, tenantOf(req), actorOf(req), req.params.id, req.body.status)),
  );
  r.post('/v1/connections/:id/health-check', { schema: { tags: ['connections'], params: Id } }, async (req) =>
    connectionsModule.checkConnectionHealth(deps, tenantOf(req), req.params.id),
  );

  /* ---------------- evidence (M01) ---------------- */
  r.post('/v1/evidence/sources', { schema: { tags: ['evidence'], body: z.record(z.string(), z.unknown()) } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => evidence.registerSource(tx, tenantOf(req), actorOf(req), req.body))),
  );
  r.post('/v1/evidence/sources/:id/review', { schema: { tags: ['evidence'], params: Id, body: z.object({ decision: z.enum(['approved', 'blocked']) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => evidence.reviewSource(tx, tenantOf(req), actorOf(req), req.params.id, req.body.decision)),
  );
  r.post('/v1/evidence', { schema: { tags: ['evidence'], body: z.record(z.string(), z.unknown()) } }, async (req, reply) =>
    reply.status(201).send(await tenantTx(ctx, req, (tx) => evidence.admitEvidence(tx, tenantOf(req), actorOf(req), req.body as never, { now: deps.clock.now() }))),
  );
  r.get(
    '/v1/evidence',
    { schema: { tags: ['evidence'], querystring: z.object({ status: z.string().optional(), kind: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }) } },
    async (req) => tenantTx(ctx, req, (tx) => evidence.listEvidence(tx, req.query)),
  );
  r.get('/v1/evidence/:id', { schema: { tags: ['evidence'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => evidence.getEvidence(tx, req.params.id)));
  r.get('/v1/evidence/:id/lineage', { schema: { tags: ['evidence'], params: Id } }, async (req) => tenantTx(ctx, req, (tx) => evidence.evidenceLineage(tx, req.params.id)));
  r.post('/v1/evidence/:id/release', { schema: { tags: ['evidence'], params: Id, body: z.record(z.string(), z.unknown()) } }, async (req) =>
    tenantTx(ctx, req, (tx) => evidence.resolveQuarantine(tx, tenantOf(req), actorOf(req), req.params.id, req.body)),
  );
  r.post('/v1/evidence/:id/reject', { schema: { tags: ['evidence'], params: Id, body: z.object({ note: z.string().min(3) }) } }, async (req) =>
    tenantTx(ctx, req, (tx) => evidence.rejectEvidence(tx, tenantOf(req), actorOf(req), req.params.id, req.body.note)),
  );
}
