import { randomUUID } from 'node:crypto';
import { connections, socialPosts, withTenant } from '@futuregrow/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { checkCaption, classifySpam, platformReadiness, schedulePost, xWeightedLength } from '../src/modules/m16-social/index.js';

let h: CoreHarness;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.deps.db, { tenantId: h.tenantId, actor: 'test:platforms' }, fn);

beforeAll(async () => {
  h = await createCoreHarness();
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('platform formats (D-042)', () => {
  it("counts X's weighted length: code points below U+1100 (Latin, Bangla) 1, Hangul 2, emoji 2, URLs 23", () => {
    expect(xWeightedLength('hello')).toBe(5);
    expect(xWeightedLength('안전모')).toBe(6);
    expect(xWeightedLength('শব্দ')).toBe([...'শব্দ'].length);
    expect(xWeightedLength('👍🏽')).toBe(2);
    expect(xWeightedLength('see https://example.com/a/very/long/path?x=1')).toBe(4 + 23);
  });

  it('refuses copy that does not fit a platform instead of cutting it, and notes link handling', () => {
    const bangla = 'আজকের শব্দ: হেলমেট। '.repeat(15);
    expect(checkCaption('facebook', bangla).ok).toBe(true);
    const x = checkCaption('x', bangla);
    expect(x).toMatchObject({ ok: false, limit: 280 });
    expect(x.problems[0]).toMatch(/weighted characters exceed x's 280/);
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ');
    expect(checkCaption('instagram', tags).problems).toEqual(["31 hashtags exceed instagram's 30"]);
    expect(checkCaption('instagram', 'learn', { link: 'https://example.com' }).notes[0]).toMatch(/not make caption links clickable/);
    expect(checkCaption('tiktok', 'x', { images: 1 }).problems).toContain('tiktok needs a video, not images');
    expect(checkCaption('reddit', 'x').ok).toBe(false);
  });
});

describe('comment spam and duplicate screen', () => {
  it('flags promotions and copy-paste campaigns with explainable signals; ordinary questions pass', () => {
    expect(classifySpam('এই শব্দটা কিভাবে উচ্চারণ করবো?', 'a', [])).toEqual({ verdict: 'ok', signals: [] });
    expect(classifySpam('Earn $500 daily, inbox me on WhatsApp +880 1711 000000', 'a', [])).toMatchObject({ verdict: 'likely_spam', signals: expect.arrayContaining(['contact_invite', 'money_promo', 'phone_number']) });
    expect(classifySpam('telegram group আছে?', 'a', []).verdict).toBe('suspicious');
    const msg = 'Great lesson, thank you so much!';
    expect(classifySpam(msg, 'a', [{ authorHash: 'a', text: msg }])).toMatchObject({ verdict: 'duplicate', signals: ['repeated_by_author'] });
    expect(
      classifySpam(msg, 'c', [
        { authorHash: 'a', text: msg },
        { authorHash: 'b', text: 'great lesson, THANK you so much' },
      ]),
    ).toMatchObject({ verdict: 'duplicate', signals: ['copied_across_authors'] });
    expect(classifySpam(msg, 'c', [{ authorHash: 'a', text: msg }]).verdict).toBe('ok');
  });
});

describe('platform readiness', () => {
  it('reports real operational status per platform and never shows an unconnected or disabled platform as working', async () => {
    const now = h.clock.now();
    let r = await tx((t) => platformReadiness(t, now));
    const status = () => Object.fromEntries(r.map((p) => [p.platform, p.status]));
    expect(r.map((p) => p.platform)).toEqual(['facebook', 'instagram', 'x', 'reddit', 'youtube', 'tiktok', 'linkedin']);
    expect(status()).toEqual({ facebook: 'needs_connection', instagram: 'needs_connection', x: 'disabled', reddit: 'owner_assisted', youtube: 'needs_connection', tiktok: 'needs_connection', linkedin: 'needs_connection' });
    expect(r.find((p) => p.platform === 'x')!.reasons[0]).toMatch(/B-019/);
    expect(r.every((p) => p.automatedPublishing === false)).toBe(true);

    const add = (provider: string, extra: Partial<typeof connections.$inferInsert> = {}) =>
      tx((t) =>
        t
          .insert(connections)
          .values({ tenantId: h.tenantId, provider, externalAccountId: randomUUID().slice(0, 8), displayName: provider, healthStatus: 'healthy', createdBy: 'test', ...extra })
          .returning(),
      );
    const [fb] = await add('meta');
    await add('linkedin', { grantedScopes: ['w_organization_social', 'r_organization_social'] });
    await add('tiktok');
    r = await tx((t) => platformReadiness(t, now));
    expect(status()).toMatchObject({ facebook: 'ready', instagram: 'needs_connection', linkedin: 'awaiting_approval', tiktok: 'needs_video' });
    await add('linkedin', { grantedScopes: ['r_organization_social'], appAudited: true });
    r = await tx((t) => platformReadiness(t, now));
    expect(r.find((p) => p.platform === 'linkedin')!.connections.map((c) => c.missingScopes)).toContainEqual(['w_organization_social']);

    await tx((t) => t.insert(socialPosts).values({ tenantId: h.tenantId, connectionId: fb!.id, platform: 'facebook', caption: 'lesson', assetIds: [], claimIds: [], disclosure: {}, status: 'published_verified', scheduledAt: now, verifiedAt: now, createdBy: 'test' }));
    r = await tx((t) => platformReadiness(t, now));
    const facebook = r.find((p) => p.platform === 'facebook')!;
    expect(facebook).toMatchObject({ status: 'live_verified', automatedPublishing: true, lastVerifiedPostAt: now.toISOString() });
    expect(facebook.reasons.join(' ')).toMatch(/Development mode/);
    // Fifteen days later the same post no longer counts as live verification.
    r = await tx((t) => platformReadiness(t, new Date(now.getTime() + 15 * 86_400_000)));
    expect(r.find((p) => p.platform === 'facebook')!.status).toBe('ready');
  });

  it('refuses to schedule copy that exceeds the target platform', async () => {
    const [li] = await tx((t) => t.insert(connections).values({ tenantId: h.tenantId, provider: 'linkedin', externalAccountId: '777', displayName: 'Org', createdBy: 'test' }).returning());
    await expect(tx((t) => schedulePost(t, h.deps, h.tenantId, h.users.owner, { connectionId: li!.id, platform: 'linkedin', caption: 'a'.repeat(3001).slice(0, 5000), scheduledAt: new Date(h.clock.now().getTime() + 3_600_000).toISOString() }))).rejects.toThrow(/does not fit linkedin/);
  });
});
