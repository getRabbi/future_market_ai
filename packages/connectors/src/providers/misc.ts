import type { ProviderHttpError } from '../http.js';
import type { ConnectorContext, HealthResult, ReadConnector } from '../types.js';
import { googleAccessToken } from './google.js';

/* --------------------------- Google Search Console (read-only, M18) --------------------------- */

export interface SearchAnalyticsRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export async function searchConsoleQuery(ctx: ConnectorContext, siteUrl: string, startDate: string, endDate: string): Promise<SearchAnalyticsRow[]> {
  if (ctx.credentials.provider !== 'search_console') throw new Error('search_console credentials required');
  const token = await googleAccessToken(ctx.http, ctx.endpoints.googleOAuth, ctx.credentials);
  const out: SearchAnalyticsRow[] = [];
  for (let startRow = 0; startRow < 250_000; startRow += 25_000) {
    const res = await ctx.http.request<{ rows?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[] }>({
      method: 'POST',
      url: `${ctx.endpoints.searchConsole}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      headers: { authorization: `Bearer ${token}` },
      json: { startDate, endDate, dimensions: ['query', 'page'], rowLimit: 25_000, startRow },
      idempotent: true,
    });
    const rows = res.data.rows ?? [];
    for (const r of rows) {
      out.push({ query: r.keys[0] ?? '', page: r.keys[1] ?? '', clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position });
    }
    if (rows.length < 25_000) break;
  }
  return out;
}

/* --------------------------- PostHog capture (M02 forwarding) --------------------------- */

export interface PosthogEvent {
  event: string;
  distinctId: string;
  timestamp: string;
  properties: Record<string, unknown>;
  /** Deterministic event uuid: PostHog deduplicates a resent event with the same uuid. */
  uuid?: string;
}

export async function posthogCaptureBatch(ctx: ConnectorContext, events: PosthogEvent[]): Promise<{ accepted: number }> {
  if (ctx.credentials.provider !== 'posthog') throw new Error('posthog credentials required');
  if (events.length === 0) return { accepted: 0 };
  const { host, projectApiKey } = ctx.credentials;
  await ctx.http.request({
    method: 'POST',
    url: `${host.replace(/\/$/, '')}/batch/`,
    json: {
      api_key: projectApiKey,
      batch: events.map((e) => ({ event: e.event, distinct_id: e.distinctId, timestamp: e.timestamp, properties: e.properties, ...(e.uuid ? { uuid: e.uuid } : {}) })),
    },
    idempotent: false,
  });
  return { accepted: events.length };
}

/* --------------------------- Chatwoot handoff (M21) --------------------------- */

export async function chatwootCreateHandoff(ctx: ConnectorContext, args: { inboxId: number; contactName: string; transcript: string }): Promise<{ conversationId: number; contactId: number }> {
  if (ctx.credentials.provider !== 'chatwoot') throw new Error('chatwoot credentials required');
  const { baseUrl, apiAccessToken, accountId } = ctx.credentials;
  const base = `${baseUrl.replace(/\/$/, '')}/api/v1/accounts/${encodeURIComponent(accountId)}`;
  const headers = { api_access_token: apiAccessToken };
  const contact = await ctx.http.request<{ payload: { contact: { id: number; contact_inboxes: { source_id: string }[] } } }>({
    method: 'POST',
    url: `${base}/contacts`,
    headers,
    json: { inbox_id: args.inboxId, name: args.contactName },
  });
  const c = contact.data.payload.contact;
  const sourceId = c.contact_inboxes[0]?.source_id;
  const conv = await ctx.http.request<{ id: number }>({
    method: 'POST',
    url: `${base}/conversations`,
    headers,
    json: { source_id: sourceId, inbox_id: args.inboxId, contact_id: c.id, message: { content: args.transcript } },
  });
  return { conversationId: conv.data.id, contactId: c.id };
}

/* --------------------------- Health checks (read-only) --------------------------- */

const failure = (err: unknown): HealthResult => {
  const e = err as ProviderHttpError;
  return { healthy: false, status: e?.isAuthError ? 'failing' : 'degraded', grantedScopes: null, details: { error: e instanceof Error ? e.message : String(err), httpStatus: e?.status ?? null } };
};

function chatwootBase(ctx: ConnectorContext) {
  if (ctx.credentials.provider !== 'chatwoot') throw new Error('chatwoot credentials required');
  const { baseUrl, apiAccessToken, accountId } = ctx.credentials;
  return { base: `${baseUrl.replace(/\/$/, '')}/api/v1/accounts/${encodeURIComponent(accountId)}`, headers: { api_access_token: apiAccessToken } };
}

export interface ChatwootInbox {
  id: number;
  name: string;
  channelType: string;
}

/** Inboxes of the Chatwoot account (inbox mapping for M21 handoff). */
export async function chatwootListInboxes(ctx: ConnectorContext): Promise<ChatwootInbox[]> {
  const { base, headers } = chatwootBase(ctx);
  const res = await ctx.http.request<{ payload?: { id: number; name: string; channel_type: string }[] }>({ method: 'GET', url: `${base}/inboxes`, headers, idempotent: true });
  return (res.data.payload ?? []).map((i) => ({ id: i.id, name: i.name, channelType: i.channel_type }));
}

/**
 * Posts an outgoing (agent-side) or private note message to a mirrored conversation and returns
 * the provider's message id; callers record delivery only from this id, never from intent.
 */
export async function chatwootPostMessage(ctx: ConnectorContext, args: { conversationId: number; content: string; private: boolean }): Promise<{ messageId: number; createdAt: number | null }> {
  const { base, headers } = chatwootBase(ctx);
  const res = await ctx.http.request<{ id: number; created_at?: number }>({
    method: 'POST',
    url: `${base}/conversations/${args.conversationId}/messages`,
    headers,
    json: { content: args.content, message_type: 'outgoing', private: args.private },
  });
  if (typeof res.data.id !== 'number') throw new Error('chatwoot returned no message id');
  return { messageId: res.data.id, createdAt: res.data.created_at ?? null };
}

export const chatwootRead: ReadConnector = {
  provider: 'chatwoot',
  async healthCheck(ctx) {
    try {
      const inboxes = await chatwootListInboxes(ctx);
      const mapped = Number((ctx.connection.metadata as { inboxId?: unknown }).inboxId);
      const inboxMapped = Number.isInteger(mapped) && inboxes.some((i) => i.id === mapped);
      return {
        healthy: inboxMapped,
        status: inboxMapped ? 'healthy' : 'degraded',
        grantedScopes: null,
        details: { inboxes, inboxMapped, ...(inboxMapped ? {} : { warning: 'Record the Chatwoot inbox id that receives handoffs (connection metadata inboxId); it must be one of the listed inboxes.' }) },
      };
    } catch (err) {
      return failure(err);
    }
  },
};

/** Search Console: the connection's property must be in the account's site list with a verified permission. */
export const searchConsoleRead: ReadConnector = {
  provider: 'search_console',
  async healthCheck(ctx) {
    try {
      if (ctx.credentials.provider !== 'search_console') throw new Error('search_console credentials required');
      const token = await googleAccessToken(ctx.http, ctx.endpoints.googleOAuth, ctx.credentials);
      const res = await ctx.http.request<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>({ method: 'GET', url: `${ctx.endpoints.searchConsole}/sites`, headers: { authorization: `Bearer ${token}` }, idempotent: true });
      const sites = res.data.siteEntry ?? [];
      const mine = sites.find((s) => s.siteUrl === ctx.connection.externalAccountId);
      const verified = Boolean(mine && mine.permissionLevel !== 'siteUnverifiedUser');
      return {
        healthy: verified,
        status: verified ? 'healthy' : 'degraded',
        grantedScopes: null,
        details: {
          property: ctx.connection.externalAccountId,
          permissionLevel: mine?.permissionLevel ?? null,
          properties: sites.map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel })),
          ...(verified ? {} : { warning: mine ? 'The account is not a verified user of this property.' : 'This property is not in the account’s Search Console site list (use the exact URL-prefix or sc-domain: form).' }),
        },
      };
    } catch (err) {
      return failure(err);
    }
  },
};

/**
 * PostHog: the project key is checked against the public flags endpoint (the capture API accepts
 * any payload asynchronously, so it cannot prove the key). Nothing is captured by the check.
 */
export const posthogRead: ReadConnector = {
  provider: 'posthog',
  async healthCheck(ctx) {
    try {
      if (ctx.credentials.provider !== 'posthog') throw new Error('posthog credentials required');
      const { host, projectApiKey } = ctx.credentials;
      if (!/^https:\/\//.test(host) && !host.startsWith('http://127.0.0.1')) throw new Error('PostHog host must be an https URL');
      await ctx.http.request({ method: 'POST', url: `${host.replace(/\/$/, '')}/flags?v=2`, json: { api_key: projectApiKey, distinct_id: 'futuregrow-health-check' }, idempotent: true });
      return { healthy: true, status: 'healthy', grantedScopes: null, details: { host } };
    } catch (err) {
      return failure(err);
    }
  },
};
