import { MODULES } from '@futuregrow/contracts';
import { loadEnv } from '@futuregrow/runtime';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { buildApp } from '../../api/src/app.js';
import { AUTOPILOT_CALLS } from '../src/components/Autopilot.js';
import { CONNECTION_CALLS } from '../src/components/Connections.js';
import { REGISTRIES } from '../src/components/Governance.js';
import { GROUND_TRUTH_CALLS } from '../src/components/GroundTruth.js';
import { allForms, SECTION_GROUPS, SECTIONS } from '../src/lib/catalog.js';
import type { Field, RecordSource } from '../src/lib/forms.js';

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
const norm = (p: string) =>
  p
    .split('?')[0]!
    .replace(UUID, ':id')
    .replace(/:[A-Za-z]+/g, ':id');

const WITH_GOVERNANCE = [...SECTIONS, { slug: 'governance', resources: REGISTRIES }];

/** References people type because they live outside FUTUREGROW (a consent record, a store localisation, a source address). */
const TYPED_REFERENCES = new Set(['localizationId', 'lawfulBasisOrConsentId', 'sourceUriOrObjectId']);

/** Record pickers read lists too; collect every source path (fields inside repeating rows included). */
function sources(fields: Field[]): string[] {
  return fields.flatMap((f) => {
    if (f.type === 'rows') return sources(f.fields);
    if (f.type === 'evidence') return ['/v1/evidence'];
    if (f.type !== 'record') return [];
    const src: RecordSource = f.source;
    const path = typeof src.list === 'function' ? src.list({ creatorId: '00000000-0000-4000-8000-000000000001' }) : src.list;
    return path ? [path] : [];
  });
}

function calls() {
  const out: { where: string; method: string; path: string }[] = [];
  // Catalog sections plus the bespoke Governance screen's registries.
  for (const s of WITH_GOVERNANCE) {
    for (const r of s.resources) {
      if (r.list) out.push({ where: `${s.slug}/${r.title} list`, method: 'GET', path: r.list });
      if (r.detail) out.push({ where: `${s.slug}/${r.title} detail`, method: 'GET', path: r.detail });
      if (r.create) out.push({ where: `${s.slug}/${r.title} create`, method: r.create.method ?? 'POST', path: r.create.path });
      for (const a of r.rowActions ?? []) out.push({ where: `${s.slug}/${r.title} action ${a.label}`, method: a.method ?? 'POST', path: a.path });
    }
  }
  for (const { where, spec } of allForms(WITH_GOVERNANCE)) for (const path of sources(spec.fields)) out.push({ where: `${where} picker`, method: 'GET', path });
  // Bespoke screens.
  for (const c of CONNECTION_CALLS) out.push({ where: 'connections screen', method: c.method, path: c.path });
  for (const c of GROUND_TRUTH_CALLS) out.push({ where: 'ground-truth screen', method: c.method, path: c.path });
  for (const c of AUTOPILOT_CALLS) out.push({ where: 'autopilot screen', method: c.method, path: c.path });
  return out;
}

describe('control-plane catalog', () => {
  it('every UI call maps to a registered API route with the same method', () => {
    // Negative controls: the check really distinguishes paths and methods.
    expect(app.hasRoute({ method: 'GET', url: '/v1/does-not-exist' })).toBe(false);
    expect(app.hasRoute({ method: 'DELETE', url: '/v1/actions/:id' })).toBe(false);
    expect(calls().length).toBeGreaterThan(140);
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

  it('every form is guided: labelled fields, no placeholder IDs, no raw-JSON inputs', () => {
    const forms = allForms(WITH_GOVERNANCE);
    expect(forms.length).toBeGreaterThan(45);
    const ZERO = /^0{8}-0{4}-/;
    const walk = (where: string, fields: Field[]) => {
      expect(fields.length, where).toBeGreaterThan(0);
      for (const f of fields) {
        expect(f.label.trim().length, `${where} › ${f.key}`).toBeGreaterThan(1);
        // Placeholder evidence or record IDs never stand in for a real choice.
        expect(String(JSON.stringify(typeof f.initial === 'function' ? f.initial() : (f.initial ?? ''))).match(ZERO), `${where} › ${f.key} initial`).toBeNull();
        expect(f.placeholder ?? '', `${where} › ${f.key} placeholder`).not.toMatch(UUID);
        // IDs are chosen with pickers, never typed.
        if (/(Id|Ids)$/.test(f.key) && !TYPED_REFERENCES.has(f.key)) expect(['record', 'evidence'], `${where} › ${f.key}`).toContain(f.type);
        if (f.type === 'rows') walk(`${where} › ${f.label}`, f.fields);
      }
    };
    for (const { where, spec } of forms) walk(where, spec.fields);
    // Every create opens a form; nothing still ships a raw example body.
    for (const s of WITH_GOVERNANCE) for (const r of s.resources) if (r.create) expect(r.create.form.fields.length, `${s.slug}/${r.title}`).toBeGreaterThan(0);
    expect(JSON.stringify(SECTIONS)).not.toMatch(/00000000-0000-4000-8000-000000000000/);
  });

  it('module registry prefixes point at real route trees', () => {
    const routes = app.printRoutes({ commonPrefix: false });
    for (const m of MODULES) expect(routes, `${m.id} ${m.apiPrefix}`).toContain(m.apiPrefix.replace('/v1/', ''));
  });
});
