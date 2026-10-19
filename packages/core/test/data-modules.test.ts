import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { consentEvents, customerEvents, customerProfiles, dsarRequests, identityMerges, suppressions, withTenant } from '@futuregrow/db';
import { identifierHash } from '@futuregrow/observability';
import * as customers from '../src/modules/m02-customers/index.js';
import '../src/modules/m02-customers/executors.js';
import * as knowledge from '../src/modules/m03-knowledge/index.js';
import { admitEvidence } from '../src/modules/m01-evidence/index.js';
import { decideApproval, executeAction, proposeAction, verifyAction } from '../src/modules/m23-execution/gateway.js';

let h: CoreHarness;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);
const ts = (offsetSec = 0) => new Date(Date.parse('2026-10-19T15:00:00Z') + offsetSec * 1000).toISOString();

async function evidence(overrides: Record<string, unknown> = {}) {
  return tx((t) =>
    admitEvidence(
      t,
      h.tenantId,
      h.users.owner,
      {
        sourceType: 'primary',
        sourceOwner: 'acme',
        sourceUriOrObjectId: `doc://${randomUUID()}`,
        retrievedAt: h.clock.now().toISOString(),
        licenseOrUsageRights: 'first-party',
        schemaVersion: '1',
        piiClassification: 'none',
        confidence: 0.9,
        freshnessSlaHours: 24 * 365,
        permittedUses: ['publishing', 'creative_generation', 'support'],
        kind: 'document',
        content: { n: randomUUID() },
        ...overrides,
      } as never,
      { now: h.clock.now() },
    ),
  );
}

beforeAll(async () => {
  h = await createCoreHarness();
});
afterAll(async () => {
  await h?.close();
});

describe('M02 identity resolution and ingestion', () => {
  it('links anonymous activity to a known user with an explainable merge record', async () => {
    const anon = `anon-${randomUUID()}`;
    const first = await customers.ingestEvents(h.deps, h.tenantId, 'web', [
      { messageId: `m-${randomUUID()}`, event: 'page_viewed', timestamp: ts(), anonymousId: anon, properties: { path: '/pricing' } },
    ]);
    const second = await customers.ingestEvents(h.deps, h.tenantId, 'web', [
      { messageId: `m-${randomUUID()}`, event: 'signup', timestamp: ts(60), userId: 'u-42', properties: { plan: 'trial' } },
    ]);
    expect(first.profileIds[0]).not.toBe(second.profileIds[0]);
    const third = await customers.ingestEvents(h.deps, h.tenantId, 'web', [
      { messageId: `m-${randomUUID()}`, event: 'identify', timestamp: ts(120), anonymousId: anon, userId: 'u-42' },
    ]);
    const merges = await tx((t) => t.select().from(identityMerges));
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ matchRule: 'shared_user_id', matchPolicyVersion: customers.MATCH_POLICY_VERSION });
    const survivor = third.profileIds[0]!;
    const evs = await tx((t) => t.select().from(customerEvents).where(eq(customerEvents.profileId, survivor)));
    expect(evs.map((e) => e.eventName).sort()).toEqual(['identify', 'page_viewed', 'signup']);
  });

  it('never merges on an unverified email', async () => {
    const email = `shared-${randomUUID().slice(0, 6)}@example.com`;
    await customers.ingestEvents(h.deps, h.tenantId, 'web', [{ messageId: `m-${randomUUID()}`, event: 'lead', timestamp: ts(), userId: 'a-1', email }]);
    const r = await customers.ingestEvents(h.deps, h.tenantId, 'web', [{ messageId: `m-${randomUUID()}`, event: 'lead', timestamp: ts(), userId: 'b-2', email }]);
    const before = (await tx((t) => t.select().from(identityMerges))).length;
    expect(before).toBe(1); // only the previous test's merge
    expect(r.accepted).toBe(1);
  });

  it('strips direct identifiers from properties, honours denied analytics consent, deduplicates', async () => {
    const mid = `m-${randomUUID()}`;
    const r = await customers.ingestEvents(h.deps, h.tenantId, 'web', [
      { messageId: mid, event: 'form_submitted', timestamp: ts(), userId: 'u-pii', properties: { email: 'leak@example.com', contact: 'x@y.co', plan: 'pro' } },
      { messageId: mid, event: 'form_submitted', timestamp: ts(), userId: 'u-pii' },
      { messageId: `m-${randomUUID()}`, event: 'page_viewed', timestamp: ts(), anonymousId: 'z', context: { consent: { analytics: false } } },
      { messageId: `m-${randomUUID()}`, event: 'purchase', timestamp: ts(), userId: 'u-pii', revenue: 49.99, currency: 'USD', properties: { sku: 'S1' }, context: { consent: { analytics: false } } },
    ]);
    expect(r).toMatchObject({ accepted: 2, duplicates: 1 });
    expect(r.dropped).toEqual([expect.objectContaining({ reason: 'analytics consent denied' })]);
    const [stored] = await tx((t) => t.select().from(customerEvents).where(eq(customerEvents.messageId, mid)));
    expect(stored!.properties).toEqual({ plan: 'pro' });
    expect((stored!.context as { piiRemoved: string[] }).piiRemoved.sort()).toEqual(['contact', 'email']);
    const purchase = await tx((t) => t.select().from(customerEvents).where(eq(customerEvents.eventName, 'purchase')));
    expect(purchase[0]!.properties).toEqual({}); // contract event kept, minimised
    expect(purchase[0]!.revenueMicros).toBe(49_990_000);
  });
});

describe('M02 consent and suppression', () => {
  it('late-arriving older consent events cannot override newer state', async () => {
    const r = await customers.ingestEvents(h.deps, h.tenantId, 'web', [{ messageId: `m-${randomUUID()}`, event: 'signup', timestamp: ts(), userId: `c-${randomUUID()}` }]);
    const profileId = r.profileIds[0]!;
    await tx((t) => customers.recordConsent(t, h.tenantId, h.users.owner, { profileId, purpose: 'marketing_email', status: 'withdrawn', lawfulBasis: 'consent', source: 'preference_center', capturedAt: ts(600) }));
    await tx((t) => customers.recordConsent(t, h.tenantId, h.users.owner, { profileId, purpose: 'marketing_email', status: 'granted', lawfulBasis: 'consent', source: 'old_import', capturedAt: ts(0) }));
    const p = await tx((t) => customers.getProfile360(t, profileId));
    expect(p.consents.find((c) => c.purpose === 'marketing_email')!.status).toBe('withdrawn');
    const history = await tx((t) => t.select().from(consentEvents).where(eq(consentEvents.profileId, profileId)));
    expect(history).toHaveLength(2);
    await expect(
      tx((t) => customers.recordConsent(t, h.tenantId, h.users.owner, { profileId, purpose: 'marketing_email', status: 'granted', lawfulBasis: 'legitimate_interest', source: 'x', capturedAt: ts(700) })),
    ).rejects.toThrow(/require consent/);
  });

  it('distinguishes unsubscribe (commercial only) from hard suppression', async () => {
    const email = `sup-${randomUUID().slice(0, 6)}@example.com`;
    await tx((t) => customers.addSuppression(t, h.deps, h.tenantId, h.users.owner, { channel: 'email', identifier: { kind: 'email', value: email }, reason: 'unsubscribe', source: 'link' }));
    expect(await tx((t) => customers.emailSuppression(t, h.deps, email))).toEqual({ any: true, commercialOnly: true });
    await tx((t) => customers.addSuppression(t, h.deps, h.tenantId, h.users.owner, { channel: 'email', identifier: { kind: 'email', value: email.toUpperCase() }, reason: 'bounce', source: 'resend' }));
    expect(await tx((t) => customers.emailSuppression(t, h.deps, email))).toEqual({ any: true, commercialOnly: false });
  });
});

describe('M02 DSAR', () => {
  it('propagates deletion across modules and keeps only documented exemptions', async () => {
    const email = `dsar-${randomUUID().slice(0, 6)}@example.com`;
    const r = await customers.ingestEvents(h.deps, h.tenantId, 'web', [
      { messageId: `m-${randomUUID()}`, event: 'signup', timestamp: ts(), userId: `d-${randomUUID()}`, email },
      { messageId: `m-${randomUUID()}`, event: 'page_viewed', timestamp: ts(5), email },
    ], { verifiedEmail: true });
    const profileId = r.profileIds[0]!;
    await tx((t) => customers.recordConsent(t, h.tenantId, h.users.owner, { profileId, purpose: 'marketing_email', status: 'granted', lawfulBasis: 'consent', source: 'signup', capturedAt: ts() }));
    await evidence({ kind: 'observation', piiClassification: 'personal', lawfulBasisOrConsentId: 'consent:signup', content: { profileId, note: 'support transcript' } });

    const d = await tx((t) => customers.createDsar(t, h.deps, h.tenantId, h.users.privacy, { kind: 'delete', identifier: { kind: 'email', value: email } }));
    expect(d.profileIds).toEqual([profileId]);
    await expect(customers.executeDsarDeletion(h.deps, h.tenantId, h.users.privacy, d.id)).rejects.toThrow(/verified/);
    await tx((t) => customers.verifyDsarIdentity(t, h.tenantId, h.users.privacy, d.id, 'email_link_confirmation'));
    const done = await customers.executeDsarDeletion(h.deps, h.tenantId, h.users.privacy, d.id);
    expect(done.status).toBe('completed');

    const [p] = await tx((t) => t.select().from(customerProfiles).where(eq(customerProfiles.id, profileId)));
    expect(p).toMatchObject({ email: null, phone: null });
    expect(p!.deletedAt).not.toBeNull();
    expect(await tx((t) => t.select().from(customerEvents).where(eq(customerEvents.profileId, profileId)))).toHaveLength(0);
    const erased = await tx((t) => t.execute<{ n: number }>(sql`select count(*)::int as n from evidence_records where content::text like ${`%${profileId}%`}`));
    expect(erased.rows[0]!.n).toBe(0);
    const supp = await tx((t) => t.select().from(suppressions).where(eq(suppressions.identifierHash, identifierHash(h.deps.config.identifierPepper, 'email', email))));
    expect(supp.map((s) => s.reason)).toContain('dsar_delete');
    expect(await tx((t) => t.select().from(consentEvents).where(eq(consentEvents.profileId, profileId)))).toHaveLength(1); // proof-of-consent exemption
    expect((done.propagation as { exemptions: string[] }).exemptions.length).toBeGreaterThan(0);
  });

  it('access requests are exported through the M23 gateway with approval and verification', async () => {
    const email = `acc-${randomUUID().slice(0, 6)}@example.com`;
    const r = await customers.ingestEvents(h.deps, h.tenantId, 'web', [{ messageId: `m-${randomUUID()}`, event: 'signup', timestamp: ts(), userId: `acc-${randomUUID()}`, email }], { verifiedEmail: true });
    const d = await tx((t) => customers.createDsar(t, h.deps, h.tenantId, h.users.privacy, { kind: 'access', identifier: { kind: 'email', value: email } }));
    await tx((t) => customers.verifyDsarIdentity(t, h.tenantId, h.users.privacy, d.id, 'email_link_confirmation'));
    const a = await proposeAction(h.deps, h.tenantId, h.users.privacy, {
      actionType: 'data.export_customer_data',
      connectionId: null,
      params: { dsarId: d.id, profileIds: r.profileIds, purpose: 'DSAR access response' },
      risk: { geographies: ['US'] },
      idempotencyKey: `dsar-${d.id}`,
    });
    expect(a.status).toBe('APPROVAL_REQUIRED');
    expect(a.policyDecision!.approvalGroups.map((g) => g.name)).toContain('privacy');
    await decideApproval(h.deps, h.tenantId, h.users.owner, a.id, { decision: 'approved', expectedActionHash: a.actionHash });
    await decideApproval(h.deps, h.tenantId, h.users.legal, a.id, { decision: 'approved', expectedActionHash: a.actionHash });
    expect(await executeAction(h.deps, h.tenantId, a.id)).toMatchObject({ status: 'EXECUTED_UNVERIFIED' });
    expect(await verifyAction(h.deps, h.tenantId, a.id)).toMatchObject({ status: 'VERIFIED' });
    const [after] = await tx((t) => t.select().from(dsarRequests).where(eq(dsarRequests.id, d.id)));
    expect(after!.status).toBe('completed');
    const exported = JSON.parse(new TextDecoder().decode((await h.deps.store.get(after!.resultObjectKey!))!));
    expect(exported.data.events).toHaveLength(1);
  });
});

describe('M03 knowledge graph and claims', () => {
  it('versions facts and flags contradictions from older sources as conflicts', async () => {
    const e1 = await evidence({ observedAt: ts(0) });
    const v1 = await tx((t) => knowledge.upsertEntity(t, h.deps, h.tenantId, h.users.owner, { kind: 'price', key: 'plan.pro', name: 'Pro plan', attributes: { usd: 49 }, evidenceId: e1.evidenceId }));
    const e2 = await evidence({ observedAt: ts(3600) });
    const v2 = await tx((t) => knowledge.upsertEntity(t, h.deps, h.tenantId, h.users.owner, { kind: 'price', key: 'plan.pro', name: 'Pro plan', attributes: { usd: 59 }, evidenceId: e2.evidenceId }));
    expect([v1.version, v2.version, v2.status]).toEqual([1, 2, 'active']);
    const stale = await evidence({ observedAt: ts(-3600) });
    const v3 = await tx((t) => knowledge.upsertEntity(t, h.deps, h.tenantId, h.users.owner, { kind: 'price', key: 'plan.pro', name: 'Pro plan', attributes: { usd: 39 }, evidenceId: stale.evidenceId }));
    expect(v3.status).toBe('conflict');
    expect((await tx((t) => knowledge.activeFacts(t, ['price']))).filter((f) => f.key === 'plan.pro')).toHaveLength(0);
    await tx((t) => knowledge.resolveConflict(t, h.tenantId, h.users.owner, v2.id));
    expect((await tx((t) => knowledge.activeFacts(t, ['price']))).find((f) => f.key === 'plan.pro')!.attributes).toEqual({ usd: 59 });
  });

  it('claims need trusted evidence, a different approver, and legal for regulated types', async () => {
    const e = await evidence();
    const c = await tx((t) => knowledge.proposeClaim(t, h.deps, h.tenantId, h.users.operator, { text: 'Acme syncs contacts 3x faster than manual export', claimType: 'comparative', evidenceIds: [e.evidenceId] }));
    expect(c.regulated).toBe(true);
    await expect(tx((t) => knowledge.reviewClaim(t, h.tenantId, h.users.approver, c.id, 'approved'))).rejects.toThrow(/regulated/);
    const ok = await tx((t) => knowledge.reviewClaim(t, h.tenantId, h.users.legal, c.id, 'approved'));
    expect(ok.status).toBe('approved');
    const quarantined = await evidence({ licenseOrUsageRights: null });
    await expect(tx((t) => knowledge.proposeClaim(t, h.deps, h.tenantId, h.users.operator, { text: 'Unsupported', claimType: 'other', evidenceIds: [quarantined.evidenceId] }))).rejects.toThrow(/not admitted/);
    await expect(tx((t) => knowledge.proposeClaim(t, h.deps, h.tenantId, h.users.operator, { text: 'Customers love it', claimType: 'testimonial', evidenceIds: [e.evidenceId] }))).rejects.toThrow(/genuine customer/);
  });

  it('lints copy: unsubstantiated assertions and brand rules block, covered claims pass', async () => {
    const e = await evidence();
    const claim = await tx((t) => knowledge.proposeClaim(t, h.deps, h.tenantId, h.users.operator, { text: 'Save 30% on annual plans', claimType: 'price', evidenceIds: [e.evidenceId] }));
    await tx((t) => knowledge.reviewClaim(t, h.tenantId, h.users.approver, claim.id, 'approved'));
    await tx((t) => knowledge.addBrandRule(t, h.tenantId, h.users.owner, { kind: 'banned_phrase', pattern: 'synergy', severity: 'block', description: 'avoid jargon' }));

    const bad = await tx((t) => knowledge.lintCopy(t, 'The best CRM on the planet! Save 30% on annual plans. Pure synergy.', { claimIds: [], now: h.clock.now() }));
    expect(bad.passed).toBe(false);
    expect(bad.violations.map((v) => v.code)).toEqual(expect.arrayContaining(['UNSUBSTANTIATED_SUPERLATIVE', 'UNSUBSTANTIATED_STATISTIC', 'BRAND_BANNED_PHRASE']));

    const good = await tx((t) => knowledge.lintCopy(t, 'Save 30% on annual plans this month.', { claimIds: [claim.id], now: h.clock.now() }));
    expect(good).toMatchObject({ passed: true, claimsChecked: [claim.id] });

    const noDisclosure = await tx((t) => knowledge.lintCopy(t, 'Meet Nova, our new look.', { claimIds: [], requiredDisclosure: 'AI-generated brand character', now: h.clock.now() }));
    expect(noDisclosure.violations.map((v) => v.code)).toContain('DISCLOSURE_MISSING');
  });

  it('expires claims whose evidence is no longer current', async () => {
    const e = await evidence({ freshnessSlaHours: 1 });
    const c = await tx((t) => knowledge.proposeClaim(t, h.deps, h.tenantId, h.users.operator, { text: `Ships in 2 days ${randomUUID().slice(0, 4)}`, claimType: 'availability', evidenceIds: [e.evidenceId] }));
    await tx((t) => knowledge.reviewClaim(t, h.tenantId, h.users.approver, c.id, 'approved'));
    const expired = await tx((t) => knowledge.sweepClaims(t, h.tenantId, h.users.owner, new Date(h.clock.now().getTime() + 2 * 3_600_000)));
    expect(expired).toContain(c.id);
  });

  it('retrieves with role-aware visibility and fuses keyword + vector rankings', async () => {
    const e = await evidence();
    const e2 = await evidence();
    const embedder: knowledge.Embedder = {
      model: 'test-hash-embed',
      async embed(texts) {
        return texts.map((t) => {
          const v = new Array(64).fill(0);
          for (const w of t.toLowerCase().split(/\W+/).filter(Boolean)) v[[...w].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 64, 7)] += 1;
          return v;
        });
      },
    };
    await tx((t) => knowledge.ingestDocument(t, h.deps, h.tenantId, h.users.owner, { title: 'Refund policy', text: 'Refunds are available within 30 days of purchase.\n\nContact support for refund requests.', evidenceId: e.evidenceId, visibility: 'public' }, embedder));
    await tx((t) => knowledge.ingestDocument(t, h.deps, h.tenantId, h.users.owner, { title: 'Pricing playbook', text: 'Internal: discount approvals above 20% need finance sign-off. Refund exceptions require a manager.', evidenceId: e2.evidenceId, visibility: 'restricted', allowedRoles: ['finance_approver'] }, embedder));
    const pub = await tx((t) => knowledge.searchKnowledge(t, { query: 'refund', roles: [], audience: 'public', embedder }));
    expect(pub.map((r) => r.title)).toEqual(['Refund policy']);
    expect(pub[0]!.ftsRank).toBe(1);
    expect(pub[0]!.vectorRank).not.toBeNull();
    const fin = await tx((t) => knowledge.searchKnowledge(t, { query: 'refund exceptions manager', roles: ['finance_approver'], audience: 'internal' }));
    expect(fin.map((r) => r.title)).toContain('Pricing playbook');
    const other = await tx((t) => knowledge.searchKnowledge(t, { query: 'refund exceptions manager', roles: ['analyst'], audience: 'internal' }));
    expect(other.map((r) => r.title)).not.toContain('Pricing playbook');
  });

  it('chunks long documents with overlap', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'lorem ipsum '.repeat(10)}`).join('\n\n');
    const chunks = knowledge.chunkText(text, 500, 100);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length <= 700)).toBe(true);
  });
});
