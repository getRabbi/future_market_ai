import { randomUUID } from 'node:crypto';
import { connections, contentPlanItems, organization, socialPosts, studioPrograms, withTenant } from '@futuregrow/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { assignProgram, bindApp, bindChannel, createBrand, getBrand, linkIdentity, listBrands, registerCampaignLink, unbindChannel, updateBrand } from '../src/modules/brands/index.js';
import { campaignConversions, recordInstall } from '../src/modules/m19-app-growth/index.js';
import { taggedListingUrl } from '../src/modules/studio/compose.js';
import { upsertProgram } from '../src/modules/studio/index.js';

let h: CoreHarness;
let other: string;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2], tenantId = h.tenantId) => withTenant(h.deps.db, { tenantId, actor: 'test:brands' }, fn);
const DAY = 86_400_000;
const APP = 'com.example.brandapp';
const LISTING = `https://play.google.com/store/apps/details?id=${APP}`;
const PALETTE = { background: '#0F1E45', ink: '#FFFFFF', accent: '#FFC845', onAccent: '#0B3A2F' };

async function page(tenantId = h.tenantId, externalAccountId = `page-${randomUUID().slice(0, 8)}`) {
  const [c] = await tx(
    (t) =>
      t
        .insert(connections)
        .values({ tenantId, provider: 'meta', externalAccountId, displayName: `Page ${externalAccountId}`, createdBy: 'test' })
        .returning(),
    tenantId,
  );
  return c!;
}

async function planItemWithPost(programId: string, connectionId: string, day: string) {
  return tx(async (t) => {
    const [item] = await t.insert(contentPlanItems).values({ tenantId: h.tenantId, programId, day, kind: 'feature', packVersion: 'v1', objective: 'INSTALL_APP', segment: 'learners', template: 'feature', palette: 'navy', rationale: 'test' }).returning();
    const [post] = await t.insert(socialPosts).values({ tenantId: h.tenantId, connectionId, platform: 'facebook', caption: 'install', assetIds: [], claimIds: [], disclosure: {}, status: 'draft', scheduledAt: h.clock.now(), createdBy: 'test' }).returning();
    return { item: item!, post: post! };
  });
}

beforeAll(async () => {
  h = await createCoreHarness();
  other = `org_${randomUUID().slice(0, 8)}`;
  await h.t.handle.db.insert(organization).values({ id: other, name: 'Other', slug: other });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('brands (D-041)', () => {
  it('validates the profile: defaults apply, low-contrast palettes and mismatched store URLs are refused', async () => {
    const b = await tx((t) => createBrand(t, h.tenantId, h.users.owner, { slug: 'lessons', name: 'Lessons', profile: { visual: { palette: PALETTE }, audience: { countries: ['BD'], languages: ['bn'] }, objectives: ['installs', 'engagement'], destinations: [{ kind: 'android_app', url: LISTING }] } }));
    const full = await tx((t) => getBrand(t, b.id));
    expect(full.profile).toMatchObject({ voice: { emoji: 'light', tone: [] }, limits: { maxPostsPerDayPerChannel: 1, monthlyAdBudgetUsd: 0 }, audience: { countries: ['BD'] } });
    await expect(tx((t) => createBrand(t, h.tenantId, h.users.owner, { slug: 'grey', name: 'Grey', profile: { visual: { palette: { ...PALETTE, ink: '#1A2F68' } } } }))).rejects.toThrow(/contrast .* below 4.5/);
    await expect(tx((t) => createBrand(t, h.tenantId, h.users.owner, { slug: 'bad-url', name: 'Bad', profile: { destinations: [{ kind: 'android_app', url: 'https://example.com/?id=com.x.y' }] } }))).rejects.toThrow(/Google Play listing/);
    await expect(tx((t) => createBrand(t, h.tenantId, h.users.owner, { slug: 'lessons', name: 'Dup' }))).rejects.toThrow(/already exists/);
    await expect(tx((t) => createBrand(t, h.tenantId, h.users.analyst, { slug: 'nope', name: 'Nope' }))).rejects.toThrow();
    // Optimistic concurrency: a stale edit is refused instead of overwriting a newer one.
    const v2 = await tx((t) => updateBrand(t, h.tenantId, h.users.owner, b.id, { expectedVersion: 1, name: 'Lessons BD' }));
    expect(v2.version).toBe(2);
    await expect(tx((t) => updateBrand(t, h.tenantId, h.users.owner, b.id, { expectedVersion: 1, name: 'Stale' }))).rejects.toThrow(/changed since version 1/);
    // Another tenant cannot see or edit it.
    expect(await tx((t) => listBrands(t), other)).toEqual([]);
    await expect(tx((t) => updateBrand(t, other, h.users.owner, b.id, { expectedVersion: 2, name: 'x' }), other)).rejects.toThrow(/not found/);
  });

  it('maps each channel account and application to exactly one brand, within the tenant only', async () => {
    const a = await tx((t) => createBrand(t, h.tenantId, h.users.owner, { slug: 'brand-a', name: 'A' }));
    const b = await tx((t) => createBrand(t, h.tenantId, h.users.owner, { slug: 'brand-b', name: 'B' }));
    const conn = await page();
    await tx((t) => bindChannel(t, h.tenantId, h.users.owner, a.id, conn.id));
    expect(await tx((t) => bindChannel(t, h.tenantId, h.users.owner, a.id, conn.id))).toMatchObject({ brandId: a.id });
    await expect(tx((t) => bindChannel(t, h.tenantId, h.users.owner, b.id, conn.id))).rejects.toThrow(/another brand/);
    const foreign = await page(other);
    await expect(tx((t) => bindChannel(t, h.tenantId, h.users.owner, a.id, foreign.id))).rejects.toThrow(/connection not found/);
    await expect(tx((t) => bindChannel(t, other, h.users.owner, a.id, foreign.id), other)).rejects.toThrow(/brand not found/);
    const app = await tx((t) => bindApp(t, h.tenantId, h.users.owner, a.id, { platform: 'android', listingUrl: 'https://play.google.com/store/apps/details?id=com.example.only_a' }));
    expect(app).toMatchObject({ appId: 'com.example.only_a', platform: 'android' });
    await expect(tx((t) => bindApp(t, h.tenantId, h.users.owner, b.id, { platform: 'android', listingUrl: 'https://play.google.com/store/apps/details?id=com.example.only_a' }))).rejects.toThrow(/another brand/);
    await expect(tx((t) => bindApp(t, h.tenantId, h.users.owner, a.id, { platform: 'ios', listingUrl: LISTING }))).rejects.toThrow(/App Store listing/);
    const detail = await tx((t) => getBrand(t, a.id));
    expect(detail.channels.map((c) => c.connectionId)).toEqual([conn.id]);
    expect(detail.apps.map((x) => x.appId)).toEqual(['com.example.only_a']);
    expect(await tx((t) => unbindChannel(t, h.tenantId, h.users.owner, a.id, conn.id))).toEqual({ removed: 1 });
  });

  it('registers store-link identities per post and attributes installs only through that registry', async () => {
    const brand = await tx((t) => createBrand(t, h.tenantId, h.users.owner, { slug: 'attributed', name: 'Attributed' }));
    const conn = await page();
    // A program can join a brand only through its channel account.
    const program = await tx((t) => upsertProgram(t, h.tenantId, h.users.owner, { connectionId: conn.id, pack: 'eps-topik-bn', settings: { appCtaPerWeek: 2, linkPerWeek: 1, campaign: 'attr_daily' } }));
    await expect(tx((t) => upsertProgram(t, h.tenantId, h.users.owner, { connectionId: conn.id, pack: 'eps-topik-bn', settings: { appCtaPerWeek: 2, linkPerWeek: 1, campaign: 'attr_daily' }, brandId: brand.id }))).rejects.toThrow(/link the program's Facebook Page/);
    // Another program cannot reuse the campaign name (identities would collide).
    const conn2 = await page();
    await expect(tx((t) => upsertProgram(t, h.tenantId, h.users.owner, { connectionId: conn2.id, pack: 'eps-topik-bn', settings: { appCtaPerWeek: 2, linkPerWeek: 1, campaign: 'attr_daily' } }))).rejects.toThrow(/already used by another program/);

    const day = new Date(h.clock.now().getTime() - 20 * DAY).toISOString().slice(0, 10);
    const { item, post } = await planItemWithPost(program.id, conn.id, day);
    const url = taggedListingUrl(LISTING, 'attr_daily', `feature-${day.replaceAll('-', '')}`);
    const args = { programId: program.id, planItemId: item.id, postId: post.id, connectionId: conn.id, channelPlatform: 'facebook', url, createdBy: 'test' };
    expect(await tx((t) => registerCampaignLink(t, h.tenantId, args))).toEqual({ registered: false, reason: 'the program is not assigned to a brand' });
    await tx((t) => bindChannel(t, h.tenantId, h.users.owner, brand.id, conn.id));
    await tx((t) => assignProgram(t, h.tenantId, h.users.owner, brand.id, program.id));
    expect(await tx((t) => registerCampaignLink(t, h.tenantId, args))).toMatchObject({ registered: false, reason: expect.stringMatching(/not linked to the program's brand/) });
    await tx((t) => bindApp(t, h.tenantId, h.users.owner, brand.id, { platform: 'android', listingUrl: LISTING }));
    const first = await tx((t) => registerCampaignLink(t, h.tenantId, args));
    expect(first.registered).toBe(true);
    // A retried draft re-registers the same identity; different content cannot claim it.
    expect(await tx((t) => registerCampaignLink(t, h.tenantId, args))).toEqual(first);
    const other2 = await planItemWithPost(program.id, conn.id, new Date(h.clock.now().getTime() - 19 * DAY).toISOString().slice(0, 10));
    expect(await tx((t) => registerCampaignLink(t, h.tenantId, { ...args, planItemId: other2.item.id, postId: other2.post.id }))).toMatchObject({ registered: false, reason: expect.stringMatching(/already registered/) });

    const referrer = new URL(url).searchParams.get('referrer')!;
    expect(linkIdentity(url)).toEqual({ appPlatform: 'android', appId: APP, campaign: 'attr_daily', content: `feature-${day.replaceAll('-', '')}`, source: 'facebook' });
    const installedAt = new Date(h.clock.now().getTime() - 18 * DAY).toISOString();
    await recordInstall(h.deps, h.tenantId, 'key:backend', { appId: APP, platform: 'android', installId: randomUUID(), installedAt, installReferrer: referrer, consent: { analytics: true } });
    await recordInstall(h.deps, h.tenantId, 'key:backend', { appId: APP, platform: 'android', installId: randomUUID(), installedAt, installReferrer: 'utm_source=facebook&utm_medium=organic_social&utm_campaign=attr_daily&utm_content=typed-by-hand', consent: { analytics: true } });
    const query = { appId: APP, platform: 'android' as const, from: new Date(h.clock.now().getTime() - 30 * DAY).toISOString(), to: h.clock.now().toISOString() };
    const all = await tx((t) => campaignConversions(t, query, h.clock.now()));
    const mapped = all.campaigns.find((c) => c.content === `feature-${day.replaceAll('-', '')}`)!;
    expect(mapped.identity).toEqual({ status: 'registered', brandId: brand.id, programId: program.id, planItemId: item.id, postId: post.id, connectionId: conn.id, channelPlatform: 'facebook' });
    expect(mapped.metrics.installs).toBe(1);
    expect(all.campaigns.find((c) => c.content === 'typed-by-hand')!.identity.status).toBe('unregistered');
    const scoped = await tx((t) => campaignConversions(t, { ...query, brandId: brand.id }, h.clock.now()));
    expect(scoped.campaigns.map((c) => c.content)).toEqual([`feature-${day.replaceAll('-', '')}`]);
    const stranger = await tx((t) => createBrand(t, h.tenantId, h.users.owner, { slug: 'stranger', name: 'Stranger' }));
    await expect(tx((t) => campaignConversions(t, { ...query, brandId: stranger.id }, h.clock.now()))).rejects.toThrow(/not linked to that brand/);
    // The other tenant sees neither the registry nor the installs.
    expect((await tx((t) => campaignConversions(t, query, h.clock.now()), other)).campaigns).toEqual([]);
    const [p] = await tx((t) => t.select().from(studioPrograms).where(eq(studioPrograms.id, program.id)));
    expect(p!.brandId).toBe(brand.id);
  });
});
