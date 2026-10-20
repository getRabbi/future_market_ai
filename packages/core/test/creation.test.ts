import { randomUUID } from 'node:crypto';
import { withTenant } from '@futuregrow/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { makePng } from '../../../test/helpers/png.js';
import { admitEvidence } from '../src/modules/m01-evidence/index.js';
import * as knowledge from '../src/modules/m03-knowledge/index.js';
import * as offersM from '../src/modules/m12-offers/index.js';
import * as creative from '../src/modules/m13-creative/index.js';
import * as assetsM from '../src/modules/m14-assets/index.js';
import * as personas from '../src/modules/m15-personas/index.js';

let h: CoreHarness;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);
async function ev(over: Record<string, unknown> = {}) {
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
        permittedUses: ['creative_generation', 'publishing'],
        kind: 'contract',
        content: { n: randomUUID() },
        ...over,
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

describe('M12 offers and CRO', () => {
  it('computes economics against finance-approved guardrails', async () => {
    await expect(tx((t) => offersM.setGuardrail(t, h.tenantId, h.users.operator, { productRef: 'pro', currency: 'USD', listPriceMicros: 50e6, unitCostMicros: 10e6, minPriceMicros: 30e6, maxDiscountFraction: 0.3, minMarginFraction: 0.5 }))).rejects.toThrow(/roles/);
    await tx((t) => offersM.setGuardrail(t, h.tenantId, h.users.finance, { productRef: 'pro', currency: 'USD', listPriceMicros: 50e6, unitCostMicros: 10e6, minPriceMicros: 30e6, maxDiscountFraction: 0.3, minMarginFraction: 0.5 }));
    const ok = await tx((t) => offersM.createOffer(t, h.deps, h.tenantId, h.users.operator, { name: 'Fall 20', kind: 'percent_discount', productRefs: ['pro'], params: { percentage: 0.2, code: 'FALL20' }, startsAt: '2026-10-20T00:00:00Z' }));
    expect(ok.status).toBe('draft');
    expect((ok.economics as any).products[0]).toMatchObject({ offerPriceMicros: 40e6, discountFraction: expect.closeTo(0.2, 6), marginFraction: expect.closeTo(0.75, 6) });
    const tooDeep = await tx((t) => offersM.createOffer(t, h.deps, h.tenantId, h.users.operator, { name: 'Fall 40', kind: 'percent_discount', productRefs: ['pro', 'unknown-sku'], params: { percentage: 0.4 }, startsAt: '2026-10-20T00:00:00Z' }));
    expect(tooDeep.status).toBe('guardrail_failed');
    expect((tooDeep.guardrailCheck as any).violations.join(' ')).toMatch(/exceeds 30.0%.*|no approved price guardrail/);
    await expect(tx((t) => offersM.approveOffer(t, h.tenantId, h.users.operator, ok.id))).rejects.toThrow(/roles/);
    const approved = await tx((t) => offersM.approveOffer(t, h.tenantId, h.users.finance, ok.id));
    expect(approved.status).toBe('approved');
  });

  it('rejects unsubstantiated scarcity and screens dark patterns', async () => {
    await expect(tx((t) => offersM.createOffer(t, h.deps, h.tenantId, h.users.operator, { name: 'Flash', kind: 'percent_discount', productRefs: ['pro'], params: { percentage: 0.1 }, scarcityClaim: 'Only 3 left!', startsAt: '2026-10-20T00:00:00Z' }))).rejects.toThrow(/scarcity/);
    const cro = await tx(async (t) =>
      offersM.createCroHypothesis(t, h.tenantId, h.users.operator, { pageUrl: 'https://acme.example/checkout', hypothesis: 'Increase average order value with add-ons', changes: [{ element: 'checkout', change: 'Pre-select the premium support add-on by default' }], evidenceIds: [(await ev()).evidenceId] }),
    );
    expect(cro.status).toBe('blocked_dark_pattern');
    expect(offersM.darkPatternCheck('Show a clear one-click cancel button').passed).toBe(true);
  });
});

describe('M13 creative briefs', () => {
  it('requires approved claims for proof points and lints copy', async () => {
    const e = await ev({ kind: 'document' });
    const claim = await tx((t) => knowledge.proposeClaim(t, h.deps, h.tenantId, h.users.operator, { text: 'Imports 10,000 contacts in under a minute', claimType: 'statistic', evidenceIds: [e.evidenceId] }));
    const base = {
      title: 'Fast import',
      objective: 'Activation',
      channel: 'tiktok',
      audience: 'new SMB owners',
      angle: 'Setup in minutes',
      hooks: ['Moving CRMs used to take a weekend'],
      proofPoints: [{ text: 'Imports 10,000 contacts in under a minute', claimId: claim.id }],
      cta: 'Start free',
      formatPlan: { format: 'short video', aspectRatio: '9:16' },
    };
    const pending = await tx((t) => creative.createBrief(t, h.deps, h.tenantId, h.users.operator, base));
    expect(pending.status).toBe('lint_failed');
    await tx((t) => knowledge.reviewClaim(t, h.tenantId, h.users.approver, claim.id, 'approved'));
    const ok = await tx((t) => creative.createBrief(t, h.deps, h.tenantId, h.users.operator, base));
    expect(ok.status).toBe('draft');
    const hype = await tx((t) => creative.createBrief(t, h.deps, h.tenantId, h.users.operator, { ...base, hooks: ['The #1 CRM in the world, guaranteed'] }));
    expect(hype.status).toBe('lint_failed');
  });
});

describe('M15 synthetic personas', () => {
  const persona = (over: Record<string, unknown> = {}) => ({
    name: 'Nova',
    personaBible: { backstory: 'Nova is a fictional, AI-generated brand character who explains product features.', voiceTone: 'friendly' },
    visualIdentity: {},
    voiceIdentity: {},
    disclosureCopy: 'Nova is an AI-generated virtual brand character.',
    likeness: { origin: 'original_synthetic', attestation: 'Designed in-house; no real person was used as reference.' },
    ...over,
  });

  it('blocks impersonation, missing disclosure and child personas; approves disclosed originals', async () => {
    await tx((t) => personas.addProtectedIdentity(t, h.tenantId, h.users.legal, { name: 'Taylor Swift', reason: 'celebrity' }));
    const imp = await tx((t) => personas.createPersona(t, h.tenantId, h.users.operator, persona({ name: 'Taylor Swift Fan' })));
    expect(imp.status).toBe('blocked');
    const noDisc = await tx((t) => personas.createPersona(t, h.tenantId, h.users.operator, persona({ name: 'Orion', disclosureCopy: 'Meet Orion, your new best friend!' })));
    expect(noDisc.status).toBe('blocked');
    const child = await tx((t) => personas.createPersona(t, h.tenantId, h.users.operator, persona({ name: 'Pip', childPersona: true })));
    expect(child.status).toBe('blocked');
    const nova = await tx((t) => personas.createPersona(t, h.tenantId, h.users.operator, persona()));
    expect(nova.status).toBe('draft');
    expect((nova.platformDisclosures as any).tiktok).toEqual({ is_aigc: true });
    await expect(tx((t) => personas.approvePersona(t, h.tenantId, h.users.approver, nova.id))).rejects.toThrow(/roles/);
    expect((await tx((t) => personas.approvePersona(t, h.tenantId, h.users.legal, nova.id))).status).toBe('approved');
  });

  it('flags fabricated first-person experience', () => {
    expect(personas.personaContentCheck('I tried this for 30 days and my results were amazing').passed).toBe(false);
    expect(personas.personaContentCheck('Here is how the import wizard works').passed).toBe(true);
  });
});

describe('M14 assets', () => {
  it('derives publish eligibility from the rights manifest and QA', async () => {
    const png = makePng(64, 32);
    const a = await tx((t) => assetsM.uploadAsset(t, h.deps, h.tenantId, h.users.operator, { kind: 'image', title: 'hero', contains: { music: false, voice: false, likeness: false, aiGenerated: false } }, png));
    expect(a).toMatchObject({ mime: 'image/png', width: 64, height: 32, publishEligible: false });
    expect(a.eligibilityReasons).toContain('missing source-media rights');
    const rightsEv = await ev();
    const unknown = await tx((t) => assetsM.addRights(t, h.deps, h.tenantId, h.users.operator, a.id, [{ component: 'source_media', rightsHolder: 'Acme', licenseRef: 'own photography', commercialUse: 'unknown', evidenceId: rightsEv.evidenceId }]));
    expect(unknown.publishEligible).toBe(false);
    const b = await tx((t) => assetsM.uploadAsset(t, h.deps, h.tenantId, h.users.operator, { kind: 'image', title: 'hero2' }, makePng(64, 33)));
    const ok = await tx((t) => assetsM.addRights(t, h.deps, h.tenantId, h.users.operator, b.id, [{ component: 'source_media', rightsHolder: 'Acme', licenseRef: 'own photography', commercialUse: 'allowed', evidenceId: rightsEv.evidenceId }]));
    expect(ok.publishEligible).toBe(true);
    await expect(tx((t) => assetsM.uploadAsset(t, h.deps, h.tenantId, h.users.operator, { kind: 'video', title: 'not a video' }, png))).rejects.toThrow(/declared kind/);
  });

  it('render requests are blocked until the Remotion licence is recorded', async () => {
    const img = await tx((t) => assetsM.uploadAsset(t, h.deps, h.tenantId, h.users.operator, { kind: 'image', title: 'src' }, makePng(48, 48)));
    const rightsEv = await ev();
    await tx((t) => assetsM.addRights(t, h.deps, h.tenantId, h.users.operator, img.id, [{ component: 'source_media', rightsHolder: 'Acme', licenseRef: 'own', commercialUse: 'allowed', evidenceId: rightsEv.evidenceId }]));
    const blocked = await tx((t) => assetsM.requestRender(t, h.deps, h.tenantId, h.users.operator, { composition: 'product_showcase', inputAssetIds: [img.id], props: { headline: 'Meet the new import wizard' } }));
    expect(blocked.status).toBe('blocked_license');
    await expect(tx((t) => assetsM.recordRemotionLicense(t, h.tenantId, h.users.admin, { eligibility: 'free_license', basis: 'organization_up_to_3_people', teamSize: 3, attestation: 'We are a three-person company as of 2026-10.' }))).rejects.toThrow(/roles/);
    await tx((t) => assetsM.recordRemotionLicense(t, h.tenantId, h.users.owner, { eligibility: 'free_license', basis: 'organization_up_to_3_people', teamSize: 3, attestation: 'We are a three-person company as of 2026-10.' }));
    const queued = await tx((t) => assetsM.requestRender(t, h.deps, h.tenantId, h.users.operator, { composition: 'product_showcase', inputAssetIds: [img.id], props: { headline: 'Meet the new import wizard' } }));
    expect(queued.status).toBe('queued');
    expect(queued.configSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(tx((t) => assetsM.requestRender(t, h.deps, h.tenantId, h.users.operator, { composition: 'product_showcase', inputAssetIds: [img.id], props: { headline: 'The best CRM, guaranteed' } }))).rejects.toThrow(/lint/);
  });
});
