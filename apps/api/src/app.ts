import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { type CoreDeps, conversationsModule, type knowledge, ops } from '@futuregrow/core';
import { type Env, origins } from '@futuregrow/runtime';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { type Auth, createAuth } from './auth.js';
import { type ApiContext, registerErrorHandler, registerTenantHooks, sendWebResponse, toWebRequest } from './http.js';
import { registerCoreRoutes } from './routes/core-routes.js';
import { registerModuleRoutes } from './routes/module-routes.js';
import { registerPublicRoutes } from './routes/public-routes.js';
import { registerWebhookRoutes } from './routes/webhooks.js';

export interface BuildAppOptions {
  env: Env;
  deps: CoreDeps;
  auth?: Auth;
  embedder?: knowledge.Embedder;
  /** Label for operator alerts (runtime.environment). */
  environment?: string;
}

export async function buildApp({ env, deps, auth: providedAuth, embedder, environment = env.NODE_ENV }: BuildAppOptions): Promise<{ app: FastifyInstance; auth: Auth }> {
  const auth = providedAuth ?? createAuth(deps.db, env);
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    requestIdHeader: 'x-request-id',
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Keep the exact raw body: webhook signatures are computed over it.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    req.rawBody = raw;
    if (!raw.length) return done(null, null);
    try {
      done(null, JSON.parse(raw));
    } catch {
      const err = new Error('invalid JSON body') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    req.rawBody = raw;
    done(null, Object.fromEntries(new URLSearchParams(raw)));
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } });
  const appCors = {
    origin: origins(env),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'idempotency-key', 'x-fg-tenant', 'x-request-id'],
    exposedHeaders: ['idempotent-replayed', 'x-request-id'],
  };
  // Chat widgets run on tenant storefronts: their origins come from the widget record, never
  // with credentials. Everything else uses the control-plane origin list.
  await app.register(cors, {
    delegator: (req, cb) => {
      const m = (req.url ?? '').match(/^\/chat\/v1\/w\/(fgw_pk_[A-Za-z0-9_-]{16,64})\//);
      if (!m) return cb(null, appCors);
      conversationsModule.widgetOrigins(deps, m[1]!).then(
        (list) => cb(null, list.length ? { origin: list, credentials: false, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['content-type', 'x-fg-visitor-token'] } : { origin: false }),
        (err: Error) => cb(err, { origin: false }),
      );
    },
  });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute', keyGenerator: (req) => req.ip });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'FUTUREGROW AI API', version: '0.1.0', description: 'Evidence-governed, bounded-autonomy growth platform. All /v1 mutations require an Idempotency-Key header.' },
      components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'fg.session_token' } } },
      security: [{ session: [] }],
    },
    transform: jsonSchemaTransform,
  });

  const ctx: ApiContext = { deps, auth, ...(embedder ? { embedder } : {}) };
  // Unhandled 5xx: one operator alert per route and error type per 15 min (max 10 per hour).
  const notifier = deps.notifier ?? new ops.LogNotifier(deps.logger);
  const throttle = new ops.AlertThrottle();
  registerErrorHandler(app, (err, req) => {
    const route = req.routeOptions.url ?? 'unknown';
    const key = `api5xx:${req.method} ${route}:${err.name}`;
    if (!throttle.allow(key)) return;
    void notifier.send({ severity: 'critical', title: `API error on ${req.method} ${route}`, text: `${err.name}: ${err.message}`.slice(0, 500), source: 'api', environment, dedupKey: key, fields: { requestId: req.id } }).catch((e: unknown) => req.log.warn({ err: e }, 'operator alert failed'));
  });
  registerTenantHooks(app, ctx);

  app.get('/healthz', { config: { public: true } }, async () => ({ ok: true }));
  app.get('/readyz', { config: { public: true } }, async (_req, reply) => {
    try {
      const r = await deps.db.execute<{ n: number }>(sql`select count(*)::int as n from action_state_transitions`);
      if ((r.rows[0]?.n ?? 0) === 0) return reply.status(503).send({ ok: false, reason: 'migrations not applied' });
      return { ok: true };
    } catch (err) {
      return reply.status(503).send({ ok: false, reason: err instanceof Error ? err.message : 'db unavailable' });
    }
  });
  // Coarse component status for uptime monitors (no tenant data): 503 when a component is stale or failing.
  let statusCache: { at: number; value: ops.PlatformStatus } | null = null;
  app.get('/statusz', { config: { public: true } }, async (_req, reply) => {
    if (!statusCache || Date.now() - statusCache.at > 30_000) statusCache = { at: Date.now(), value: await ops.platformStatus(deps.db) };
    const s = statusCache.value;
    reply.header('cache-control', 'no-store');
    const components = Object.fromEntries(Object.entries(s.components).map(([k, v]) => [k, { state: v.state, ...(v.ageSeconds === undefined ? {} : { ageSeconds: v.ageSeconds }) }]));
    return reply.status(s.ok ? 200 : 503).send({ ok: s.ok, checkedAt: s.checkedAt, components });
  });
  app.get('/v1/openapi.json', { config: { public: true } }, async () => app.swagger());

  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    config: { public: true, rateLimit: { max: 60, timeWindow: '1 minute' } },
    handler: async (req, reply) => sendWebResponse(reply, await auth.handler(toWebRequest(req))),
  });

  registerCoreRoutes(app, ctx);
  registerModuleRoutes(app, ctx);
  registerPublicRoutes(app, ctx);
  registerWebhookRoutes(app, ctx, env);
  return { app, auth };
}
