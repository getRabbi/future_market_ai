import { createHash } from 'node:crypto';
import { getActionType } from '@futuregrow/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CAPABILITY_SEEDS, EXECUTORS, fromLittle, READ_CONNECTORS, toLittle } from '../src/index.js';
import { FixtureServer, makeCtx, meta } from './helpers.js';

const server = new FixtureServer();
beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => server.reset());

const exec = (t: string) =>
  EXECUTORS[t] as unknown as {
    execute: (c: unknown, p: unknown, m: unknown) => Promise<any>;
    verify: (c: unknown, p: unknown, r: unknown) => Promise<any>;
    rollback: (c: unknown, p: unknown, r: unknown, b: unknown) => Promise<any>;
    verifyRollback: (c: unknown, p: unknown, r: unknown, b: unknown) => Promise<any>;
  };
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode('card')]);
const sha = createHash('sha256').update(png).digest('hex');
const assetId = '00000000-0000-4000-8000-0000000000a1';
const withImage = <T extends object>(c: T) => ({ ...c, loadAsset: async () => ({ bytes: png, mime: 'image/png', sha256: sha, publicUrl: null }) });

describe('LinkedIn organization posts (Posts API)', () => {
  const ctx = () => withImage(makeCtx(server, { provider: 'linkedin', accessToken: 'LI_TOKEN' }, { externalAccountId: '5515715' }));
  const URN = 'urn:li:share:6844785523593134080';

  it('escapes the little text format and reverses it for verification', () => {
    const text = 'Learn (fast) with *notes* — #korean @team';
    expect(toLittle(text)).toBe('Learn \\(fast\\) with \\*notes\\* — #korean \\@team');
    expect(fromLittle('Learn \\(fast\\) with \\*notes\\* — {hashtag|\\#|korean} \\@team')).toBe(text);
  });

  it('uploads the approved image, posts as the organization, verifies by read-back and deletes on rollback', async () => {
    server.on('POST', '/rest/images', { json: { value: { uploadUrl: `${server.baseUrl}/upload/img1`, image: 'urn:li:image:C1' } } });
    server.on('PUT', '/upload/img1', { status: 201 });
    server.on('POST', '/rest/posts', { status: 201, headers: { 'x-restli-id': URN }, json: {} });
    let deleted = false;
    server.on('GET', `/rest/posts/${encodeURIComponent(URN)}`, () =>
      deleted ? { status: 404, json: { message: 'not found' } } : { json: { id: URN, author: 'urn:li:organization:5515715', commentary: 'আজকের শব্দ \\(safety\\) {hashtag|\\#|korean}', visibility: 'PUBLIC', lifecycleState: 'PUBLISHED', content: { media: { id: 'urn:li:image:C1' } } } },
    );
    server.on('DELETE', `/rest/posts/${encodeURIComponent(URN)}`, () => {
      deleted = true;
      return { status: 204 };
    });
    const e = exec('social.linkedin.publish_post');
    const p = { authorUrn: 'urn:li:organization:5515715', commentary: 'আজকের শব্দ (safety) #korean', media: [{ assetId, sha256: sha }], postId: assetId, assetIds: [assetId], claimIds: [], disclosure: {} };
    const r = await e.execute(ctx(), p, meta);
    expect(r.receipt).toMatchObject({ providerObjectId: URN, details: { images: ['urn:li:image:C1'] } });
    const post = server.find('POST', '/rest/posts')[0]!;
    expect(post.headers['linkedin-version']).toBe('202610');
    expect(post.headers['x-restli-protocol-version']).toBe('2.0.0');
    expect(JSON.parse(post.body)).toMatchObject({ author: 'urn:li:organization:5515715', commentary: 'আজকের শব্দ \\(safety\\) #korean', visibility: 'PUBLIC', lifecycleState: 'PUBLISHED', content: { media: { id: 'urn:li:image:C1' } } });
    expect(server.find('PUT', '/upload/img1')[0]!.raw.equals(Buffer.from(png))).toBe(true);
    expect((await e.verify(ctx(), p, r.receipt)).verdict).toBe('VERIFIED');
    await e.rollback(ctx(), p, r.receipt, null);
    expect((await e.verifyRollback(ctx(), p, r.receipt, null)).verdict).toBe('VERIFIED');
  });

  it('refuses bytes that differ from the approved hash and a non-organization author, before sending', async () => {
    const e = exec('social.linkedin.publish_post');
    const bad = { authorUrn: 'urn:li:organization:1', commentary: 'x', media: [{ assetId, sha256: 'f'.repeat(64) }], postId: assetId, assetIds: [assetId], claimIds: [], disclosure: {} };
    await expect(e.execute(ctx(), bad, meta)).rejects.toThrow(/differs from the approved/);
    await expect(e.execute(ctx(), { ...bad, authorUrn: 'urn:li:person:abc', media: [] }, meta)).rejects.toThrow(/not an organization URN/);
    expect(server.find('POST', '/rest/posts')).toHaveLength(0);
  });

  it('reports a mismatch when LinkedIn shows different text, and health requires a posting role on that organization', async () => {
    server.on('POST', '/rest/posts', { status: 201, headers: { 'x-restli-id': URN }, json: {} });
    server.on('GET', `/rest/posts/${encodeURIComponent(URN)}`, { json: { id: URN, author: 'urn:li:organization:5515715', commentary: 'edited', visibility: 'PUBLIC', lifecycleState: 'PUBLISHED' } });
    const e = exec('social.linkedin.publish_post');
    const p = { authorUrn: 'urn:li:organization:5515715', commentary: 'original', postId: assetId, assetIds: [], claimIds: [], disclosure: {} };
    const r = await e.execute(ctx(), p, meta);
    expect((await e.verify(ctx(), p, r.receipt)).verdict).toBe('MISMATCH');
    server.on('GET', '/rest/organizationAcls', { json: { elements: [{ organization: 'urn:li:organization:5515715', role: 'ANALYST', state: 'APPROVED' }] } });
    expect(await READ_CONNECTORS.linkedin!.healthCheck(ctx())).toMatchObject({ healthy: false, details: { canPost: false } });
    server.reset();
    server.on('GET', '/rest/organizationAcls', { json: { elements: [{ organization: 'urn:li:organization:5515715', role: 'CONTENT_ADMIN', state: 'APPROVED' }] } });
    expect(await READ_CONNECTORS.linkedin!.healthCheck(ctx())).toMatchObject({ healthy: true, details: { roles: ['CONTENT_ADMIN'] } });
  });
});

describe('X posts (API v2) — implemented, disabled until per-request spend is authorized', () => {
  const ctx = () => withImage(makeCtx(server, { provider: 'x', accessToken: 'X_TOKEN' }, { externalAccountId: '42' }));

  it('ships unsupported, so M23 policy denies it, while the executor itself works against the documented contract', async () => {
    expect(getActionType('social.x.publish_post')).toMatchObject({ supported: false, blockerRef: 'B-019' });
    expect(CAPABILITY_SEEDS.find((c) => c.capability === 'x_post_create')).toMatchObject({ supported: false });
    server.on('POST', '/2/media/upload', { json: { data: { id: '1880028106020515840', media_key: '3_1880028106020515840' } } });
    server.on('POST', '/2/tweets', { status: 201, json: { data: { id: '1445880548472328192', text: 'hi' } } });
    server.on('GET', '/2/tweets/1445880548472328192', { json: { data: { id: '1445880548472328192', text: 'অনুশীলন করুন https://t.co/abc', author_id: '42', attachments: { media_keys: ['3_1880028106020515840'] } } } });
    server.on('DELETE', '/2/tweets/1445880548472328192', { json: { data: { deleted: true } } });
    const e = exec('social.x.publish_post');
    const p = { text: 'অনুশীলন করুন https://example.com/x', media: [{ assetId, sha256: sha }], postId: assetId, assetIds: [assetId], claimIds: [], disclosure: {} };
    const r = await e.execute(ctx(), p, meta);
    expect(r.receipt.providerObjectId).toBe('1445880548472328192');
    const up = server.find('POST', '/2/media/upload')[0]!;
    expect(up.headers['content-type']).toMatch(/^multipart\/form-data/);
    expect(up.body).toContain('name="media_category"\r\n\r\ntweet_image');
    expect(JSON.parse(server.find('POST', '/2/tweets')[0]!.body)).toEqual({ text: p.text, media: { media_ids: ['1880028106020515840'] } });
    // t.co rewriting is not a mismatch; the author and the attached media count are checked.
    expect((await e.verify(ctx(), p, r.receipt)).verdict).toBe('VERIFIED');
    const rb = await e.rollback(ctx(), p, r.receipt, null);
    expect(rb.receipt.details).toEqual({ deleted: true });
  });

  it('health is healthy only for the connected account', async () => {
    server.on('GET', '/2/users/me', { json: { data: { id: '99', username: 'someone_else' } } });
    expect(await READ_CONNECTORS.x!.healthCheck(ctx())).toMatchObject({ healthy: false, details: { error: expect.stringMatching(/different X account/) } });
  });
});
