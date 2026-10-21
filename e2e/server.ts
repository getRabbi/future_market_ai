/**
 * Browser E2E stack: embedded PostgreSQL 17 (migrated), the real Fastify API and the production
 * web build (apps/web/dist, PUBLIC_API_BASE empty = same-origin as behind the Pages proxy) on one
 * origin. Static responses carry the headers from dist/_headers, so the strict hashed CSP that
 * Cloudflare Pages serves is enforced in the browser during the tests.
 *
 * Usage: tsx e2e/server.ts   (started by Playwright's webServer; stops PostgreSQL on exit)
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { governance } from '@futuregrow/core';
import { createRuntime, loadEnv } from '@futuregrow/runtime';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { buildApp } from '../apps/api/src/app.js';
import { createAuth } from '../apps/api/src/auth.js';
import { runAllMigrations } from '../packages/db/src/migrate.js';
import { E2E_ORIGIN, E2E_PORT, ORG, OWNER } from './fixtures.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'apps/web/dist');
if (!fs.existsSync(path.join(dist, '_headers'))) {
  console.error('apps/web/dist is missing: run `PUBLIC_API_BASE= npm run build -w @futuregrow/web` first');
  process.exit(2);
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

const pgPort = await freePort();
const pgDir = path.join(root, '.data', `pg-e2e-${process.pid}`);
fs.rmSync(pgDir, { recursive: true, force: true });
const pgServer = new EmbeddedPostgres({ databaseDir: pgDir, user: 'postgres', password: 'fg-e2e-only', port: pgPort, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
await pgServer.initialise();
await pgServer.start();
const admin = new pg.Client({ connectionString: `postgres://postgres:fg-e2e-only@localhost:${pgPort}/postgres` });
await admin.connect();
await admin.query(`create database fg_e2e encoding 'UTF8' template template0`);
await admin.end();
const databaseUrl = `postgres://postgres:fg-e2e-only@localhost:${pgPort}/fg_e2e`;
await runAllMigrations(databaseUrl);

const env = loadEnv({
  NODE_ENV: 'development',
  LOG_LEVEL: 'warn',
  DATABASE_URL: databaseUrl,
  API_BASE_URL: E2E_ORIGIN,
  APP_BASE_URL: E2E_ORIGIN,
  APP_ORIGINS: E2E_ORIGIN,
  FG_ALLOW_SIGNUP: 'false',
  FG_CHECK_BREACHED_PASSWORDS: 'false',
  FG_LOCAL_STORAGE_DIR: path.join(pgDir, 'objects'),
} as NodeJS.ProcessEnv);
const runtime = await createRuntime(env, 'api');
await governance.syncCapabilityRegistry(runtime.deps.db);
await governance.seedModelRegistry(runtime.deps.db);

// Seed the first owner the way DEPLOYMENT §5 does (sign-up opened once), then serve invite-only.
const seedAuth = createAuth(runtime.deps.db, { ...env, FG_ALLOW_SIGNUP: true });
const { user } = await seedAuth.api.signUpEmail({ body: OWNER });
await seedAuth.api.createOrganization({ body: { ...ORG, userId: user.id } });

const { app } = await buildApp({ env, deps: runtime.deps });

/** Cloudflare Pages `_headers`: path patterns with `*`, all matching blocks apply. */
const headerRules = fs
  .readFileSync(path.join(dist, '_headers'), 'utf8')
  .split(/\n(?=\/)/)
  .map((block) => {
    const [pattern, ...lines] = block.trim().split('\n');
    const re = new RegExp(
      `^${pattern!
        .trim()
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replaceAll('*', '.*')}$`,
    );
    const headers = lines
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()] as const);
    return { re, headers };
  });

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };

function resolveStatic(urlPath: string): string | null {
  const clean = path.posix.normalize(decodeURIComponent(urlPath.split('?')[0]!));
  if (clean.includes('..')) return null;
  const candidates = [clean, path.posix.join(clean, 'index.html'), `${clean.replace(/\/$/, '')}.html`];
  for (const c of candidates) {
    const file = path.join(dist, c);
    if (file.startsWith(dist) && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

app.setNotFoundHandler((req, reply) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'not found' } });
  const file = resolveStatic(req.url);
  if (!file) return reply.status(404).type('text/plain').send('not found');
  const urlPath = req.url.split('?')[0]!;
  for (const rule of headerRules) if (rule.re.test(urlPath)) for (const [k, v] of rule.headers) reply.header(k, v);
  return reply.type(TYPES[path.extname(file)] ?? 'application/octet-stream').send(fs.readFileSync(file));
});

await app.listen({ port: E2E_PORT, host: 'localhost' });
console.log(`e2e stack ready on ${E2E_ORIGIN} (postgres :${pgPort})`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await app.close().catch(() => {});
  await runtime.close().catch(() => {});
  await pgServer.stop().catch(() => {});
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(pgDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  process.exit(0);
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => void stop());
