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
      const auth = { authorization: `Bearer ${creds(ctx).apiKey}` };
      const res = await ctx.http.request<{ data: { id?: string; name: string; status: string }[] }>({ method: 'GET', url: `${ctx.endpoints.resend}/domains`, headers: auth, idempotent: true });
      const verified = res.data.data.filter((d) => d.status === 'verified').map((d) => d.name);
      // Sending-domain readiness: for each domain that is not verified yet, which DNS records (SPF, DKIM) Resend still waits for.
      const pending: { name: string; status: string; records: { record: string; type: string; name: string; status: string }[] }[] = [];
      for (const d of res.data.data.filter((x) => x.status !== 'verified' && x.id).slice(0, 5)) {
        const r = await ctx.http.request<{ records?: { record: string; type: string; name: string; status: string }[] }>({ method: 'GET', url: `${ctx.endpoints.resend}/domains/${encodeURIComponent(d.id!)}`, headers: auth, idempotent: true });
        pending.push({ name: d.name, status: d.status, records: (r.data.records ?? []).map((x) => ({ record: x.record, type: x.type, name: x.name, status: x.status })) });
      }
      return {
        healthy: verified.length > 0,
        status: verified.length ? 'healthy' : 'degraded',
        grantedScopes: null,
        details: {
          verifiedDomains: verified,
          pendingDomains: pending,
          // Resend verifies SPF and DKIM; DMARC is a separate TXT record at _dmarc.<domain> that Resend does not check.
          dmarc: 'not checked by Resend: publish a TXT record at _dmarc.<domain> (p=none or stricter) before sending lifecycle email',
          ...(verified.length ? {} : { warning: 'No verified sending domain: add the SPF and DKIM records Resend lists, then verify the domain in Resend.' }),
        },
      };
    } catch (err) {
      const e = err as ProviderHttpError;
      return { healthy: false, status: e.isAuthError ? 'failing' : 'degraded', grantedScopes: null, details: { error: e.message } };
    }
  },
};
