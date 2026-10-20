import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { sql } from 'drizzle-orm';
import type { CoreDeps, knowledge } from '@futuregrow/core';
import { type Auth, createAuth } from './auth.js';
import { type Env, origins } from '@futuregrow/runtime';
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
}

export async function buildApp({ env, deps, auth: providedAuth, embedder }: BuildAppOptions): Promise<{ app: FastifyInstance; auth: Auth }> {
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
  await app.register(cors, {
    origin: origins(env),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'idempotency-key', 'x-fg-tenant', 'x-request-id'],
    exposedHeaders: ['idempotent-replayed', 'x-request-id'],
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
  registerErrorHandler(app);
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
