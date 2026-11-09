import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chatwootListInboxes, chatwootPostMessage, EXECUTORS, READ_CONNECTORS } from '../src/index.js';
import { FixtureServer, makeCtx } from './helpers.js';

const server = new FixtureServer();
beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => server.reset());

const health = (provider: keyof typeof READ_CONNECTORS) => READ_CONNECTORS[provider]!.healthCheck;

describe('P2 health checks (read-only)', () => {
  it('Chatwoot: lists inboxes and is healthy only when the handoff inbox is one of them', async () => {
    server.on('GET', '/api/v1/accounts/7/inboxes', (req) => (req.headers.api_access_token === 'CW_TOKEN' ? { json: { payload: [{ id: 3, name: 'Website', channel_type: 'Channel::Api' }] } } : { status: 401, json: { error: 'Invalid Access Token' } }));
    const creds = { provider: 'chatwoot' as const, baseUrl: server.baseUrl, apiAccessToken: 'CW_TOKEN', accountId: '7' };
    const ok = await health('chatwoot')(makeCtx(server, creds, { metadata: { inboxId: '3' } }));
    expect(ok).toMatchObject({ healthy: true, status: 'healthy', details: { inboxMapped: true, inboxes: [{ id: 3, name: 'Website', channelType: 'Channel::Api' }] } });
    const unmapped = await health('chatwoot')(makeCtx(server, creds, { metadata: { inboxId: '9' } }));
    expect(unmapped).toMatchObject({ healthy: false, status: 'degraded', details: { inboxMapped: false } });
    const bad = await health('chatwoot')(makeCtx(server, { ...creds, apiAccessToken: 'WRONG' }));
    expect(bad).toMatchObject({ healthy: false, status: 'failing' });
  });

  it('Chatwoot: an agent message is recorded only with the provider message id', async () => {
    server.on('POST', '/api/v1/accounts/7/conversations/41/messages', { json: { id: 900, created_at: 1762560000 } });
    const ctx = makeCtx(server, { provider: 'chatwoot', baseUrl: server.baseUrl, apiAccessToken: 'CW_TOKEN', accountId: '7' });
    expect(await chatwootPostMessage(ctx, { conversationId: 41, content: 'Thanks, an agent will reply here.', private: false })).toEqual({ messageId: 900, createdAt: 1762560000 });
    expect(server.find('POST', '/api/v1/accounts/7/conversations/41/messages')[0]!.json).toEqual({ content: 'Thanks, an agent will reply here.', message_type: 'outgoing', private: false });
    server.on('POST', '/api/v1/accounts/7/conversations/42/messages', { json: {} });
    await expect(chatwootPostMessage(ctx, { conversationId: 42, content: 'x', private: true })).rejects.toThrow(/no message id/);
    server.on('GET', '/api/v1/accounts/7/inboxes', { json: {} });
    expect(await chatwootListInboxes(ctx)).toEqual([]);
  });

  it('Search Console: healthy only for a verified property in the site list', async () => {
    server.on('POST', '/oauth/token', { json: { access_token: 'ya29.sc', expires_in: 3600 } });
    server.on('GET', '/webmasters/v3/sites', {
      json: {
        siteEntry: [
          { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
          { siteUrl: 'https://shop.example.com/', permissionLevel: 'siteUnverifiedUser' },
        ],
      },
    });
    const creds = { provider: 'search_console' as const, clientId: 'cid', clientSecret: 'cs', refreshToken: 'rt-sc-1' };
    expect(await health('search_console')(makeCtx(server, creds, { externalAccountId: 'sc-domain:example.com' }))).toMatchObject({ healthy: true, details: { permissionLevel: 'siteOwner' } });
    expect(await health('search_console')(makeCtx(server, { ...creds, refreshToken: 'rt-sc-2' }, { externalAccountId: 'https://shop.example.com/' }))).toMatchObject({ healthy: false, status: 'degraded', details: { permissionLevel: 'siteUnverifiedUser' } });
    expect(await health('search_console')(makeCtx(server, { ...creds, refreshToken: 'rt-sc-3' }, { externalAccountId: 'https://other.example/' }))).toMatchObject({ healthy: false, details: { permissionLevel: null } });
    expect(server.find('GET', '/webmasters/v3/sites')[0]!.headers.authorization).toBe('Bearer ya29.sc');
  });

  it('PostHog: checks the project key without capturing anything; an invalid key fails', async () => {
    server.on('POST', '/flags', (req) => ((req.json as { api_key?: string }).api_key === 'phc_good' ? { json: { flags: {} } } : { status: 401, json: { type: 'authentication_error', detail: 'Project API key invalid.' } }));
    const ok = await health('posthog')(makeCtx(server, { provider: 'posthog', projectApiKey: 'phc_good', host: server.baseUrl }));
    expect(ok).toMatchObject({ healthy: true });
    expect(server.find('POST', '/batch/')).toHaveLength(0);
    expect(server.find('POST', '/flags')[0]!.query.get('v')).toBe('2');
    const bad = await health('posthog')(makeCtx(server, { provider: 'posthog', projectApiKey: 'phc_bad', host: server.baseUrl }));
    expect(bad).toMatchObject({ healthy: false, status: 'failing' });
    const insecure = await health('posthog')(makeCtx(server, { provider: 'posthog', projectApiKey: 'phc_good', host: 'http://posthog.example' }));
    expect(insecure).toMatchObject({ healthy: false, details: { error: expect.stringMatching(/https/) } });
  });

  it('Resend: reports which SPF/DKIM records an unverified sending domain still waits for', async () => {
    server.on('GET', '/domains', { json: { data: [{ id: 'd1', name: 'mail.example.com', status: 'pending' }] } });
    server.on('GET', '/domains/d1', {
      json: {
        id: 'd1',
        name: 'mail.example.com',
        status: 'pending',
        records: [
          { record: 'SPF', type: 'TXT', name: 'send', status: 'verified', value: 'v=spf1 include:amazonses.com ~all' },
          { record: 'DKIM', type: 'TXT', name: 'resend._domainkey', status: 'pending', value: 'p=MIGf…' },
        ],
      },
    });
    const r = await health('resend')(makeCtx(server, { provider: 'resend', apiKey: 're_test' }));
    expect(r).toMatchObject({
      healthy: false,
      status: 'degraded',
      details: {
        verifiedDomains: [],
        pendingDomains: [
          {
            name: 'mail.example.com',
            records: [
              { record: 'SPF', status: 'verified' },
              { record: 'DKIM', status: 'pending' },
            ],
          },
        ],
        dmarc: expect.stringMatching(/_dmarc/),
      },
    });
  });
});

describe('PayPal Payouts adapter (P2-14, contract only; execution disabled B-015)', () => {
  const p = { payoutRequestId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', creatorId: '00000000-0000-4000-8000-0000000000c1', items: [{ itemId: 'item-0', receiver: 'riley@pay.example', amountMicros: 15_000_000, currency: 'USD', note: 'Commission payout' }] };
  const ctx = () => makeCtx(server, { provider: 'paypal', clientId: 'cid', clientSecret: 'sec', environment: 'sandbox' });
  const exec = EXECUTORS['creator.payout'] as unknown as { execute: (c: unknown, p: unknown, m: unknown) => Promise<any>; verify: (c: unknown, p: unknown, r: unknown) => Promise<any> };

  it('ships disabled and maps amounts to PayPal decimal strings', async () => {
    const { CAPABILITY_SEEDS, paypalAmount, mapPaypalBatchStatus } = await import('../src/index.js');
    expect(CAPABILITY_SEEDS.find((c) => c.capability === 'creator_payout_create')).toMatchObject({ supported: false });
    expect(paypalAmount(15_000_000, 'USD')).toBe('15.00');
    expect(paypalAmount(1_500_000_000, 'JPY')).toBe('1500');
    expect(['SUCCESS', 'PENDING', 'DENIED', 'WEIRD'].map(mapPaypalBatchStatus)).toEqual(['paid', 'pending', 'denied', 'unknown']);
  });

  it('pays one idempotent batch (sender_batch_id = request id) and is paid only after read-back SUCCESS', async () => {
    let status = 'PENDING';
    server.on('POST', '/v1/oauth2/token', (req) => (req.headers.authorization === `Basic ${Buffer.from('cid:sec').toString('base64')}` ? { json: { access_token: 'A21' } } : { status: 401, json: {} }));
    server.on('POST', '/v1/payments/payouts', { status: 201, json: { batch_header: { payout_batch_id: 'BATCH1', batch_status: 'PENDING' } } });
    server.on('GET', '/v1/payments/payouts/BATCH1', () => ({ json: { batch_header: { batch_status: status }, items: [{ payout_item: { sender_item_id: 'item-0' }, transaction_status: status === 'SUCCESS' ? 'SUCCESS' : 'PENDING' }] } }));
    const r = await exec.execute(ctx(), p, { actionId: 'a', idempotencyKey: 'k' });
    expect(r.receipt.providerObjectId).toBe('BATCH1');
    const sent = server.find('POST', '/v1/payments/payouts')[0]!;
    expect(sent.headers['paypal-request-id']).toBe(p.payoutRequestId);
    expect(sent.json).toMatchObject({ sender_batch_header: { sender_batch_id: p.payoutRequestId }, items: [{ recipient_type: 'EMAIL', amount: { value: '15.00', currency: 'USD' }, receiver: 'riley@pay.example', sender_item_id: 'item-0' }] });
    expect((await exec.verify(ctx(), p, r.receipt)).verdict).toBe('PENDING');
    status = 'SUCCESS';
    expect((await exec.verify(ctx(), p, r.receipt)).verdict).toBe('VERIFIED');
    status = 'DENIED';
    expect((await exec.verify(ctx(), p, r.receipt)).verdict).toBe('MISMATCH');
  });

  it('refuses invalid items before calling PayPal', async () => {
    await expect(exec.execute(ctx(), { ...p, items: [{ ...p.items[0]!, receiver: 'not-an-email' }] }, { actionId: 'a', idempotencyKey: 'k' })).rejects.toThrow(/invalid payout item/);
    expect(server.requests).toHaveLength(0);
  });
});
