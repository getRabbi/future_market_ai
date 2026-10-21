import { MODULES } from '@futuregrow/contracts';
import { loadEnv } from '@futuregrow/runtime';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { buildApp } from '../../api/src/app.js';
import { CONNECTION_CALLS } from '../src/components/Connections.js';
import { REGISTRIES } from '../src/components/Governance.js';
import { SECTION_GROUPS, SECTIONS } from '../src/lib/catalog.js';

let h: CoreHarness;
let app: FastifyInstance;

beforeAll(async () => {
  h = await createCoreHarness();
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: h.t.url, API_BASE_URL: 'http://localhost:8080', APP_ORIGINS: 'http://localhost:4321' } as NodeJS.ProcessEnv);
  ({ app } = await buildApp({ env, deps: h.deps }));
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await h?.close();
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const norm = (p: string) => p.split('?')[0]!.replace(UUID, ':id');

/** Same inference ResourcePanel uses for body-less row actions. */
const isRead = (path: string) => /\/(lineage|points|stats|performance|snapshots|download-url)$/.test(path);

function calls() {
  const out: { where: string; method: string; path: string }[] = [];
  // Catalog sections plus the bespoke Governance screen's registries.
  for (const s of [...SECTIONS, { slug: 'governance', resources: REGISTRIES }]) {
    for (const r of s.resources) {
      if (r.list) out.push({ where: `${s.slug}/${r.title} list`, method: 'GET', path: r.list });
      if (r.detail) out.push({ where: `${s.slug}/${r.title} detail`, method: 'GET', path: r.detail });
      if (r.create) out.push({ where: `${s.slug}/${r.title} create`, method: r.create.method ?? 'POST', path: r.create.path });
      for (const a of r.rowActions ?? []) {
        const read = !a.body && !a.prompt && !a.method && isRead(a.path);
        out.push({ where: `${s.slug}/${r.title} action ${a.label}`, method: read ? 'GET' : (a.method ?? 'POST'), path: a.path });
      }
    }
  }
  // Bespoke Connections screen.
  for (const c of CONNECTION_CALLS) out.push({ where: 'connections screen', method: c.method, path: c.path });
  return out;
}

describe('control-plane catalog', () => {
  it('every UI call maps to a registered API route with the same method', () => {
    // Negative controls: the check really distinguishes paths and methods.
    expect(app.hasRoute({ method: 'GET', url: '/v1/does-not-exist' })).toBe(false);
    expect(app.hasRoute({ method: 'DELETE', url: '/v1/actions/:id' })).toBe(false);
    expect(calls().length).toBeGreaterThan(100);
    const missing = calls().filter((c) => !app.hasRoute({ method: c.method as 'GET', url: norm(c.path) }));
    expect(missing).toEqual([]);
  });

  it('covers all 24 modules and every section is reachable from the navigation', () => {
    const covered = new Set(SECTIONS.flatMap((s) => s.modules));
    expect(MODULES.map((m) => m.id).filter((id) => !covered.has(id))).toEqual([]);
    const nav = new Set(SECTION_GROUPS.flatMap((g) => g.slugs));
    expect(SECTIONS.map((s) => s.slug).filter((s) => !nav.has(s))).toEqual([]);
    expect(new Set(SECTIONS.map((s) => s.slug)).size).toBe(SECTIONS.length);
  });

  it('example payloads are valid JSON objects', () => {
    for (const s of SECTIONS) for (const r of s.resources) if (r.create) expect(typeof JSON.parse(JSON.stringify(r.create.example))).toBe('object');
  });

  it('module registry prefixes point at real route trees', () => {
    const routes = app.printRoutes({ commonPrefix: false });
    for (const m of MODULES) expect(routes, `${m.id} ${m.apiPrefix}`).toContain(m.apiPrefix.replace('/v1/', ''));
  });
});
