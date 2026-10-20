import type { Actor, CoreDeps, knowledge } from '@futuregrow/core';
import { authUser, beginIdempotent, completeIdempotent, DbError, idempotencyKeys, isValidIdempotencyKey, member, withSystem, withTenant } from '@futuregrow/db';
import { FgError, sha256Canonical } from '@futuregrow/observability';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { Auth } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
    tenantId?: string;
    rawBody?: string;
    idempotency?: { key: string; requestHash: string };
  }
}

export interface ApiContext {
  deps: CoreDeps;
  auth: Auth;
  /** Approved embeddings provider, when configured (D-007). */
  embedder?: knowledge.Embedder;
}

/** Convert a Fastify request to a Web Request for Better Auth. */
export function toWebRequest(req: FastifyRequest): Request {
  const url = new URL(req.url, `${req.protocol}://${req.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else headers.set(k, String(v));
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, { method: req.method, headers, body: hasBody ? (req.rawBody ?? (req.body ? JSON.stringify(req.body) : undefined)) : undefined });
}

export async function sendWebResponse(reply: FastifyReply, res: Response): Promise<void> {
  reply.status(res.status);
  res.headers.forEach((v, k) => {
    if (k.toLowerCase() !== 'set-cookie') reply.header(k, v);
  });
  const cookies = res.headers.getSetCookie();
  if (cookies.length) reply.header('set-cookie', cookies);
  reply.send(res.body ? await res.text() : null);
}

/**
 * Resolve the session (Better Auth), the active tenant and the caller's roles. Tenant = header
 * `x-fg-tenant` or the session's active organization; membership is always verified.
 */
export async function resolveActor(ctx: ApiContext, req: FastifyRequest): Promise<{ actor: Actor; tenantId: string }> {
  const session = await ctx.auth.api.getSession({ headers: toWebRequest(req).headers });
  if (!session) throw new FgError('UNAUTHENTICATED', 'sign in required', 401);
  const headerTenant = req.headers['x-fg-tenant'];
  const tenantId = (typeof headerTenant === 'string' && headerTenant) || (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;
  if (!tenantId) throw new FgError('NO_TENANT', 'select an organization (x-fg-tenant header or active organization)', 400);
  const found = await withSystem(ctx.deps.db, `user:${session.user.id}`, async (tx) => {
    const [m] = await tx
      .select()
      .from(member)
      .where(and(eq(member.organizationId, tenantId), eq(member.userId, session.user.id)));
    const [u] = await tx.select({ twoFactorEnabled: authUser.twoFactorEnabled }).from(authUser).where(eq(authUser.id, session.user.id));
    return { m, u };
  });
  if (!found.m) throw new FgError('FORBIDDEN', 'not a member of this organization', 403);
  return {
    tenantId,
    actor: {
      type: 'user',
      id: session.user.id,
      roles: found.m.role
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean),
      // Better Auth only issues a session after the second factor when 2FA is enabled.
      mfaVerified: found.u?.twoFactorEnabled === true,
    },
  };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const STALE_IN_PROGRESS_MS = 5 * 60_000;

/**
 * D-010: every /v1 mutation needs an Idempotency-Key. The key is claimed before the handler
 * runs; replays return the stored response; same key + different body => 422.
 */
export function registerTenantHooks(app: FastifyInstance, ctx: ApiContext): void {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/v1/') || req.routeOptions.config?.public === true) return;
    const { actor, tenantId } = await resolveActor(ctx, req);
    req.actor = actor;
    req.tenantId = tenantId;
    if (!MUTATING.has(req.method)) return;

    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !isValidIdempotencyKey(key)) {
      throw new FgError('IDEMPOTENCY_KEY_REQUIRED', 'mutations require an Idempotency-Key header (8-200 chars [A-Za-z0-9._:-])', 400);
    }
    const requestHash = sha256Canonical({ method: req.method, url: req.url, body: req.body ?? null, actor: actor.id });
    const begin = await withTenant(ctx.deps.db, { tenantId, actor: `user:${actor.id}` }, async (tx) => {
      const r = await beginIdempotent(tx, { tenantId, scope: 'api', key, requestHash });
      if (r.state === 'in_progress') {
        // Take over a claim abandoned by a crashed request.
        const taken = await tx
          .update(idempotencyKeys)
          .set({ createdAt: new Date() })
          .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.scope, 'api'), eq(idempotencyKeys.key, key), eq(idempotencyKeys.status, 'in_progress'), sql`${idempotencyKeys.createdAt} < ${new Date(Date.now() - STALE_IN_PROGRESS_MS)}`))
          .returning({ key: idempotencyKeys.key });
        if (taken.length) return { state: 'new' as const };
      }
      return r;
    });
    if (begin.state === 'replay') {
      reply.header('idempotent-replayed', 'true');
      reply.status(begin.status).send(begin.body);
      return reply;
    }
    if (begin.state === 'conflict') throw new FgError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with a different request', 422);
    if (begin.state === 'in_progress') throw new FgError('IDEMPOTENCY_IN_PROGRESS', 'a request with this Idempotency-Key is still in progress', 409);
    req.idempotency = { key, requestHash };
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const idem = req.idempotency;
    if (!idem || !req.tenantId || !req.actor) return payload;
    const status = reply.statusCode;
    await withTenant(ctx.deps.db, { tenantId: req.tenantId, actor: `user:${req.actor.id}` }, async (tx) => {
      if (status >= 500) {
        // Server failure: release the claim so the client can retry safely.
        await tx.delete(idempotencyKeys).where(and(eq(idempotencyKeys.tenantId, req.tenantId!), eq(idempotencyKeys.scope, 'api'), eq(idempotencyKeys.key, idem.key)));
        return;
      }
      let body: unknown = payload;
      if (typeof payload === 'string') {
        try {
          body = JSON.parse(payload);
        } catch {
          body = payload;
        }
      }
      await completeIdempotent(tx, { tenantId: req.tenantId!, scope: 'api', key: idem.key, status, body });
    });
    return payload;
  });
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((rawErr, req, reply) => {
    const err = rawErr as Error;
    const send = (status: number, code: string, message: string, details?: unknown) => reply.status(status).send({ error: { code, message, ...(details ? { details } : {}) } });
    if (err instanceof FgError) return send(err.httpStatus, err.code, err.message, err.details);
    if (err instanceof ZodError) return send(422, 'VALIDATION_FAILED', 'request validation failed', err.issues);
    if ((err as { validation?: unknown }).validation) return send(422, 'VALIDATION_FAILED', err.message, (err as unknown as { validation: unknown }).validation);
    if (err instanceof DbError) {
      if (err.isUniqueViolation) return send(409, 'CONFLICT', 'resource already exists', { constraint: err.constraint });
      if (err.isRlsViolation || err.isPermissionDenied) return send(403, 'FORBIDDEN', 'not permitted');
      if (err.isCheckViolation || err.code === '23502' || err.code === '22P02') return send(422, 'INVALID', err.message.replace(/\s*\[constraint.*$/, ''), { constraint: err.constraint });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return send(status, 'BAD_REQUEST', err.message);
    req.log.error({ err }, 'unhandled error');
    return send(500, 'INTERNAL', 'internal error');
  });
}

/** Helper for handlers: run inside the caller's tenant transaction. */
export function tenantTx<T>(ctx: ApiContext, req: FastifyRequest, fn: Parameters<typeof withTenant<T>>[2]): Promise<T> {
  return withTenant(ctx.deps.db, { tenantId: req.tenantId!, actor: `user:${req.actor!.id}` }, fn);
}

export function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw new FgError('UNAUTHENTICATED', 'sign in required', 401);
  return req.actor;
}

export function tenantOf(req: FastifyRequest): string {
  if (!req.tenantId) throw new FgError('NO_TENANT', 'no tenant', 400);
  return req.tenantId;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    public?: boolean;
  }
}
