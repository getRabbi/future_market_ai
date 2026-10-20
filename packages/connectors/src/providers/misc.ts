import type { ConnectorContext } from '../types.js';
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
      batch: events.map((e) => ({ event: e.event, distinct_id: e.distinctId, timestamp: e.timestamp, properties: e.properties })),
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
