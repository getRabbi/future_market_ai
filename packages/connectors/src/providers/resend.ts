import { ProviderHttpError } from '../http.js';
import { type ActionExecutor, type ConnectorContext, type HealthResult, proof, type ReadConnector } from '../types.js';

type ResendCreds = Extract<ConnectorContext['credentials'], { provider: 'resend' }>;

function creds(ctx: ConnectorContext): ResendCreds {
  if (ctx.credentials.provider !== 'resend') throw new Error('resend credentials required');
  return ctx.credentials;
}

/** Fully resolved message, produced by the lifecycle module at the execution boundary. */
export interface ResolvedEmail {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string | null;
  text: string;
  /** RFC 8058 one-click unsubscribe URL (required for commercial mail). */
  unsubscribeUrl: string | null;
  messageId: string;
}

export const resendSendEmail: ActionExecutor<ResolvedEmail> = {
  actionType: 'email.send',
  provider: 'resend',
  async execute(ctx, p, meta) {
    const headers: Record<string, string> = {};
    if (p.unsubscribeUrl) {
      headers['List-Unsubscribe'] = `<${p.unsubscribeUrl}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    const res = await ctx.http.request<{ id: string }>({
      method: 'POST',
      url: `${ctx.endpoints.resend}/emails`,
      headers: { authorization: `Bearer ${creds(ctx).apiKey}`, 'idempotency-key': meta.idempotencyKey },
      json: {
        from: p.from,
        to: [p.to],
        ...(p.replyTo ? { reply_to: p.replyTo } : {}),
        subject: p.subject,
        text: p.text,
        ...(p.html ? { html: p.html } : {}),
        headers,
        tags: [{ name: 'fg_message', value: p.messageId.replaceAll('-', '_') }],
      },
      // The provider honours Idempotency-Key, so a retry cannot send a duplicate.
      idempotent: true,
    });
    if (!res.data?.id) throw new ProviderHttpError('resend returned no email id', { status: res.status, phase: 'ambiguous', body: res.data });
    return {
      receipt: { providerRequestId: res.requestId, providerObjectId: res.data.id, httpStatus: res.status, responseSha256: res.sha256, observedAt: ctx.now().toISOString(), details: {} },
      beforeState: null,
      rawResponse: res.data,
    };
  },
  async verify(ctx, _p, receipt) {
    const res = await ctx.http.request<{ id: string; last_event?: string }>({
      method: 'GET',
      url: `${ctx.endpoints.resend}/emails/${encodeURIComponent(receipt.providerObjectId!)}`,
      headers: { authorization: `Bearer ${creds(ctx).apiKey}` },
      idempotent: true,
    });
    const ev = res.data.last_event ?? 'unknown';
    const observed = { lastEvent: ev };
    if (ev === 'delivered' || ev === 'opened' || ev === 'clicked') return proof('VERIFIED', 'status_poll', { lastEvent: 'delivered' }, observed, ctx.now());
    if (['bounced', 'complained', 'failed', 'canceled', 'suppressed'].includes(ev)) {
      return proof('MISMATCH', 'status_poll', { lastEvent: 'delivered' }, observed, ctx.now(), `delivery outcome: ${ev}`);
    }
    return proof('PENDING', 'status_poll', { lastEvent: 'delivered' }, observed, ctx.now(), `in flight: ${ev}`);
  },
};

export const resendRead: ReadConnector = {
  provider: 'resend',
  async healthCheck(ctx): Promise<HealthResult> {
    try {
      const res = await ctx.http.request<{ data: { name: string; status: string }[] }>({
        method: 'GET',
        url: `${ctx.endpoints.resend}/domains`,
        headers: { authorization: `Bearer ${creds(ctx).apiKey}` },
        idempotent: true,
      });
      const verified = res.data.data.filter((d) => d.status === 'verified').map((d) => d.name);
      return { healthy: verified.length > 0, status: verified.length ? 'healthy' : 'degraded', grantedScopes: null, details: { verifiedDomains: verified } };
    } catch (err) {
      const e = err as ProviderHttpError;
      return { healthy: false, status: e.isAuthError ? 'failing' : 'degraded', grantedScopes: null, details: { error: e.message } };
    }
  },
};
