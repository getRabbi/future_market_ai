import { ProviderHttpError } from '../http.js';
import type { HealthResult, ReadConnector } from '../types.js';

/**
 * Tavily (D-055, competitor discovery). The health check calls the documented
 * `GET https://api.tavily.com/usage` (bearer key): it verifies the key without running a search
 * and reports the credits used in the current billing cycle. An invalid key is a 401.
 * https://docs.tavily.com/documentation/api-reference/endpoint/usage
 */
export const TAVILY_USAGE_URL = 'https://api.tavily.com/usage';

interface UsageResponse {
  key?: { usage?: unknown; limit?: unknown; search_usage?: unknown };
  account?: { current_plan?: unknown; plan_usage?: unknown; plan_limit?: unknown; paygo_usage?: unknown; paygo_limit?: unknown };
}

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Credits left this cycle, from the plan (or, failing that, the key's own limit); null when unknown or unlimited. */
export function tavilyRemaining(u: UsageResponse): number | null {
  const planLimit = int(u.account?.plan_limit);
  const planUsage = int(u.account?.plan_usage);
  if (planLimit !== null && planUsage !== null) return planLimit - planUsage;
  const keyLimit = int(u.key?.limit);
  const keyUsage = int(u.key?.usage);
  return keyLimit !== null && keyUsage !== null ? keyLimit - keyUsage : null;
}

export const tavilyRead: ReadConnector = {
  provider: 'tavily',
  async healthCheck(ctx): Promise<HealthResult> {
    const key = ctx.credentials.provider === 'tavily' ? ctx.credentials.apiKey.trim() : '';
    if (!key) return { healthy: false, status: 'failing', grantedScopes: null, details: { error: 'Tavily API key missing' } };
    try {
      const r = await ctx.http.request<UsageResponse>({ method: 'GET', url: TAVILY_USAGE_URL, headers: { authorization: `Bearer ${key}` }, idempotent: true, timeoutMs: 15_000, maxResponseBytes: 200_000 });
      const u = r.data ?? {};
      const remaining = tavilyRemaining(u);
      const details = {
        plan: typeof u.account?.current_plan === 'string' ? u.account.current_plan : null,
        creditsUsed: int(u.account?.plan_usage) ?? int(u.key?.usage),
        creditsLimit: int(u.account?.plan_limit) ?? int(u.key?.limit),
        searchCreditsUsedByKey: int(u.key?.search_usage),
        remainingCredits: remaining,
      };
      if (remaining !== null && remaining <= 0) return { healthy: false, status: 'degraded', grantedScopes: null, details: { ...details, warning: 'This billing cycle’s credits are used up; discovery searches resume when they renew.' } };
      return { healthy: true, status: 'healthy', grantedScopes: null, details };
    } catch (err) {
      const status = err instanceof ProviderHttpError ? err.status : null;
      if (status === 401 || status === 403) return { healthy: false, status: 'failing', grantedScopes: null, details: { error: `Tavily refused the API key (HTTP ${status}). Paste the whole key from app.tavily.com, starting with tvly-.` } };
      return { healthy: false, status: 'degraded', grantedScopes: null, details: { error: `Tavily usage check unavailable${status ? ` (HTTP ${status})` : ''}: ${err instanceof Error ? err.message : String(err)}` } };
    }
  },
};
