import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chatwootListInboxes, chatwootPostMessage, READ_CONNECTORS } from '../src/index.js';
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
