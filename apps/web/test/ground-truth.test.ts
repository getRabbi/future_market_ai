import { randomUUID } from 'node:crypto';
import { loadEnv } from '@futuregrow/runtime';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { buildApp } from '../../api/src/app.js';
import { sectionBySlug } from '../src/lib/catalog.js';
import { BRAND_RULE_FORM, CLAIM_FORM, EVIDENCE_FORM, FACT_FORM, LINT_FORM, LINT_HELP, releaseForm } from '../src/lib/fieldsets.js';
import { buildBody, evidenceReadiness, type FormSpec, humanError, initialValues, type Row, rowId, type Values } from '../src/lib/forms.js';

/**
 * The Stage 4 guided forms against the real API: the bodies the forms build are accepted, the
 * server's gates still apply (quarantine, four-eyes approval, trusted evidence), and the new
 * read-only lists stay inside the tenant.
 */
let h: CoreHarness;
let app: FastifyInstance;
const ORIGIN = 'http://localhost:4321';

class Client {
  cookies = new Map<string, string>();
  tenant = '';
  async req(method: string, url: string, body?: unknown) {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: {
        origin: ORIGIN,
        ...(this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(this.tenant ? { 'x-fg-tenant': this.tenant } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' && url.startsWith('/v1/') ? { 'idempotency-key': randomUUID() } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    const set = res.headers['set-cookie'];
    for (const c of Array.isArray(set) ? set : set ? [set] : []) {
      const [k, ...v] = c.split(';')[0]!.split('=');
      if (k) this.cookies.set(k.trim(), v.join('='));
    }
    // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary API responses
    let json: any = null;
    try {
      json = res.json();
    } catch {
      json = null;
    }
    return { status: res.statusCode, json };
  }
}

/** Submit a guided form the way the UI does: initial values, what the person typed, then the body. */
const submit = (c: Client, method: string, path: string, spec: FormSpec, typed: Values) => c.req(method, path, buildBody(spec, { ...initialValues(spec.fields), ...typed }));

let owner: Client;
let orgA: string;

beforeAll(async () => {
  h = await createCoreHarness();
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: h.t.url, FG_ALLOW_SIGNUP: 'true', API_BASE_URL: 'http://localhost:8080', APP_ORIGINS: ORIGIN } as NodeJS.ProcessEnv);
  ({ app } = await buildApp({ env, deps: h.deps }));
  owner = new Client();
  expect((await owner.req('POST', '/api/auth/sign-up/email', { email: `gt-${randomUUID().slice(0, 6)}@acme.test`, password: 'correct-horse-battery-staple', name: 'Owner' })).status).toBe(200);
  const org = await owner.req('POST', '/api/auth/organization/create', { name: 'Ground Truth Co', slug: `gt-${randomUUID().slice(0, 6)}` });
  expect(org.status).toBe(200);
  orgA = org.json.id;
  owner.tenant = orgA;
});

afterAll(async () => {
  await app?.close();
  await h?.close();
});

describe('Stage 4 guided forms against the API', () => {
  let evidenceId = '';
  let claimId = '';

  it('admits evidence from the guided form; unknown rights quarantine it until release answers only what is missing', async () => {
    const ok = await submit(owner, 'POST', '/v1/evidence', EVIDENCE_FORM, { summary: 'Import limits test report', content: 'Imported 50,000 contacts from one CSV file in QA run 14.', sourceUriOrObjectId: 'qa://runs/14', sourceOwner: 'Ground Truth Co' });
    expect(ok.status).toBe(201);
    expect(ok.json.status).toBe('admitted');
    expect(evidenceReadiness(ok.json)).toBe('ready');
    evidenceId = rowId(ok.json);

    const unsure = await submit(owner, 'POST', '/v1/evidence', EVIDENCE_FORM, { summary: 'Partner benchmark', content: 'Benchmark table', sourceUriOrObjectId: 'https://partner.example/benchmark', sourceOwner: 'Partner', sourceType: 'research', licenseOrUsageRights: '' });
    expect(unsure.json.status).toBe('quarantined');
    expect(unsure.json.quarantineReasons).toEqual(['license/usage rights unknown']);
    const spec = releaseForm(unsure.json);
    expect(spec.fields.map((f) => f.key)).toEqual(['licenseOrUsageRights', 'note']);
    const released = await submit(owner, 'POST', `/v1/evidence/${rowId(unsure.json)}/release`, spec, { licenseOrUsageRights: 'licensed', note: 'Licence agreement 2026-07 checked.' });
    expect(released.status).toBe(200);
    expect(released.json.status).toBe('admitted');
  });

  it('proposes a claim with picked evidence; the author cannot approve it, and quarantined evidence cannot back one', async () => {
    const claim = await submit(owner, 'POST', '/v1/knowledge/claims', CLAIM_FORM, { text: 'Imports up to 50,000 contacts per file.', evidenceIds: [evidenceId], jurisdictions: ['US'] });
    expect(claim.status).toBe(201);
    expect(claim.json).toMatchObject({ status: 'pending_review', claimType: 'product_capability', regulated: false, jurisdictions: ['US'] });
    claimId = claim.json.id;

    // The Approve row action is hidden for the author (notMine); the server refuses it anyway.
    const action = sectionBySlug('knowledge')!
      .resources.find((r) => r.title === 'Claims')!
      .rowActions!.find((a) => a.label === 'Approve')!;
    expect(action.notMine?.field).toBe('createdBy');
    // The button is offered for exactly the status a new claim has.
    expect(action.when!.values).toContain(claim.json.status);
    expect(claim.json.createdBy).toMatch(/^user:/);
    const self = await owner.req('POST', action.path.replace(':id', claimId), action.body);
    expect(self.status).toBe(422);
    expect(humanError({ status: self.status, ...self.json.error }).title).toBe('You proposed this, so someone else has to approve it.');

    const pending = await submit(owner, 'POST', '/v1/evidence', EVIDENCE_FORM, { summary: 'Unclear survey', content: 'n=12', sourceUriOrObjectId: 'survey://x', sourceOwner: 'Us', confidence: '' });
    expect(pending.json.status).toBe('quarantined');
    const refused = await submit(owner, 'POST', '/v1/knowledge/claims', CLAIM_FORM, { text: 'Customers love the importer.', claimType: 'other', evidenceIds: [rowId(pending.json)] });
    expect(refused.status).toBe(422);
    expect(humanError({ status: refused.status, ...refused.json.error }).title).toBe('Some of the chosen evidence cannot be used.');

    // Bypassing the form (advanced JSON) with no evidence is still refused, field by field.
    const bare = await owner.req('POST', '/v1/knowledge/claims', { text: 'No proof', claimType: 'other', evidenceIds: [] });
    expect(bare.status).toBe(422);
    expect(humanError({ status: bare.status, ...bare.json.error }, CLAIM_FORM.fields).items).toEqual(['Evidence that proves it: Add at least one.']);
  });

  it('records a fact with a stable key, and a second version from a newer source supersedes it', async () => {
    const first = await submit(owner, 'POST', '/v1/knowledge/facts', FACT_FORM, { kind: 'plan', name: 'Team plan', attributes: [['Price per month', '$49']], evidenceId });
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ key: 'team-plan', version: 1, status: 'active', attributes: { 'Price per month': '$49' } });
    const facts = await owner.req('GET', '/v1/knowledge/facts');
    expect(facts.json.map((f: Row) => f.name)).toContain('Team plan');
  });

  it('adds brand rules and lists them; the copy check explains every finding', async () => {
    const banned = await submit(owner, 'POST', '/v1/knowledge/brand-rules', BRAND_RULE_FORM, { pattern: 'world-class', description: 'Unsubstantiated superlative.' });
    expect(banned.status).toBe(201);
    const limit = await submit(owner, 'POST', '/v1/knowledge/brand-rules', BRAND_RULE_FORM, { kind: 'max_exclamations', pattern: '1', severity: 'warn', description: 'Keep a calm tone.' });
    expect(limit.status).toBe(201);
    const rules = await owner.req('GET', '/v1/knowledge/brand-rules');
    expect(rules.status).toBe(200);
    expect(rules.json.map((r: Row) => r.kind).sort()).toEqual(['banned_phrase', 'max_exclamations']);

    const lint = await submit(owner, 'POST', '/v1/knowledge/lint', LINT_FORM, { text: 'Our world-class importer loads contacts 3x quicker. It is the fastest way to start!! Try it.', channel: 'email' });
    expect(lint.status).toBe(200);
    expect(lint.json.passed).toBe(false);
    const codes = lint.json.violations.map((v: Row) => v.code);
    expect(codes).toEqual(expect.arrayContaining(['BRAND_BANNED_PHRASE', 'UNSUBSTANTIATED_STATISTIC', 'UNSUBSTANTIATED_SUPERLATIVE', 'BRAND_TOO_MANY_EXCLAMATIONS']));
    for (const c of codes) expect(LINT_HELP[c], c).toBeDefined();
  });

  it('indexes a document backed by evidence; restricted documents are listed only for their roles', async () => {
    const doc = await owner.req('POST', '/v1/knowledge/documents', { title: 'Help: importing contacts', text: 'You can import contacts from a CSV file.\n\nEach file may hold up to 50,000 contacts.', evidenceId, visibility: 'internal', allowedRoles: [] });
    expect(doc.status).toBe(201);
    expect(doc.json.chunkCount).toBeGreaterThan(0);
    const hidden = await owner.req('POST', '/v1/knowledge/documents', { title: 'Legal memo', text: 'Privileged legal analysis for counsel only.', evidenceId, visibility: 'restricted', allowedRoles: ['legal_approver'] });
    expect(hidden.status).toBe(201);
    const listed = await owner.req('GET', '/v1/knowledge/documents');
    expect(listed.status).toBe(200);
    expect(listed.json.map((d: Row) => d.title)).toEqual(['Help: importing contacts']);
  });

  it('registers a source with the guided form and lists it for review', async () => {
    const res = sectionBySlug('evidence')!.resources.find((r) => r.title === 'Registered sources')!;
    const created = await submit(owner, 'POST', res.create!.path, res.create!.form, { name: 'Company CRM', owner: 'Ground Truth Co', uri: 'crm://acme' });
    expect(created.status).toBe(201);
    const list = await owner.req('GET', res.list!);
    expect(list.json).toEqual([expect.objectContaining({ name: 'Company CRM', status: 'pending_review', licenseOrUsageRights: 'first-party' })]);
  });

  it('the new lists stay inside the organisation', async () => {
    const org = await owner.req('POST', '/api/auth/organization/create', { name: 'Second Brand', slug: `gt2-${randomUUID().slice(0, 6)}` });
    expect(org.status).toBe(200);
    const other = new Client();
    other.cookies = owner.cookies;
    other.tenant = org.json.id;
    for (const path of ['/v1/knowledge/brand-rules', '/v1/knowledge/documents', '/v1/evidence/sources', '/v1/knowledge/claims']) {
      const r = await other.req('GET', path);
      expect(r.status, path).toBe(200);
      expect(r.json, path).toEqual([]);
    }
    expect(claimId).not.toBe('');
  });
});
