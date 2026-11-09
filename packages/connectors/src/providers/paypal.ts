import { ProviderHttpError, preWrite } from '../http.js';
import { type ActionExecutor, type ConnectorContext, compareProof, type HealthResult, proof, type ReadConnector } from '../types.js';

/**
 * Creator payouts (P2-14): provider-neutral contract and a PayPal Payouts adapter
 * (https://developer.paypal.com/docs/api/payments.payouts-batch/v1/). FUTUREGROW never moves money
 * on its own: the `creator.payout` action type stays unsupported (B-015) until legal review, a
 * merchant agreement and KYC exist, so M23 refuses it. The adapter is contract-tested only.
 */

export interface PayoutItem {
  itemId: string;
  receiver: string;
  amountMicros: number;
  currency: string;
  note: string;
}

export interface PayoutParams {
  payoutRequestId: string;
  creatorId: string;
  items: PayoutItem[];
}

/** Provider-neutral payout status (what reconciliation maps every provider to). */
export type PayoutStatus = 'pending' | 'processing' | 'paid' | 'partially_paid' | 'failed' | 'denied' | 'unknown';

type PaypalCreds = Extract<ConnectorContext['credentials'], { provider: 'paypal' }>;

function creds(ctx: ConnectorContext): PaypalCreds {
  if (ctx.credentials.provider !== 'paypal') throw new Error('paypal credentials required');
  return ctx.credentials;
}

const base = (ctx: ConnectorContext) => (creds(ctx).environment === 'live' ? ctx.endpoints.paypal : ctx.endpoints.paypalSandbox).replace(/\/$/, '');

/** Minor-unit decimal string PayPal expects ("10.00"); JPY-like zero-decimal currencies have no fraction. */
export function paypalAmount(amountMicros: number, currency: string): string {
  const zeroDecimal = ['JPY', 'HUF', 'TWD'].includes(currency);
  const major = amountMicros / 1_000_000;
  return zeroDecimal ? String(Math.round(major)) : major.toFixed(2);
}

async function accessToken(ctx: ConnectorContext): Promise<string> {
  const c = creds(ctx);
  const res = await ctx.http.request<{ access_token?: string }>({
    method: 'POST',
    url: `${base(ctx)}/v1/oauth2/token`,
    headers: { authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}` },
    form: { grant_type: 'client_credentials' },
    idempotent: true,
  });
  if (!res.data.access_token) throw new ProviderHttpError('paypal returned no access token', { status: res.status, phase: 'rejected' });
  return res.data.access_token;
}

export const mapPaypalBatchStatus = (s: string | undefined): PayoutStatus => (s === 'SUCCESS' ? 'paid' : s === 'PENDING' || s === 'NEW' ? 'pending' : s === 'PROCESSING' ? 'processing' : s === 'DENIED' ? 'denied' : s === 'CANCELED' ? 'failed' : 'unknown');

export async function paypalReadBatch(ctx: ConnectorContext, batchId: string): Promise<{ status: PayoutStatus; raw: string | null; items: { itemId: string; status: string }[] }> {
  const token = await accessToken(ctx);
  const res = await ctx.http.request<{ batch_header?: { batch_status?: string }; items?: { payout_item?: { sender_item_id?: string }; transaction_status?: string }[] }>({
    method: 'GET',
    url: `${base(ctx)}/v1/payments/payouts/${encodeURIComponent(batchId)}`,
    headers: { authorization: `Bearer ${token}` },
    idempotent: true,
  });
  const items = (res.data.items ?? []).map((i) => ({ itemId: i.payout_item?.sender_item_id ?? '', status: i.transaction_status ?? 'UNKNOWN' }));
  let status = mapPaypalBatchStatus(res.data.batch_header?.batch_status);
  if (status === 'paid' && items.some((i) => i.status !== 'SUCCESS')) status = 'partially_paid';
  return { status, raw: res.data.batch_header?.batch_status ?? null, items };
}

/** Pays the approved items in one PayPal batch; `sender_batch_id` is the payout request id, so a retry cannot pay twice. */
export const paypalCreatorPayout: ActionExecutor<PayoutParams> = {
  actionType: 'creator.payout',
  provider: 'paypal',
  async execute(ctx, p) {
    const items = await preWrite(async () => {
      if (!p.items.length) throw new ProviderHttpError('no payout items', { status: null, phase: 'before_send' });
      for (const i of p.items) if (i.amountMicros <= 0 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(i.receiver)) throw new ProviderHttpError(`invalid payout item ${i.itemId}`, { status: null, phase: 'before_send' });
      return p.items;
    });
    const token = await accessToken(ctx);
    const res = await ctx.http.request<{ batch_header?: { payout_batch_id?: string; batch_status?: string } }>({
      method: 'POST',
      url: `${base(ctx)}/v1/payments/payouts`,
      headers: { authorization: `Bearer ${token}`, 'paypal-request-id': p.payoutRequestId },
      json: {
        sender_batch_header: { sender_batch_id: p.payoutRequestId, email_subject: 'You have a payout', email_message: 'Your commission payout has been sent.' },
        items: items.map((i) => ({ recipient_type: 'EMAIL', amount: { value: paypalAmount(i.amountMicros, i.currency), currency: i.currency }, receiver: i.receiver, note: i.note.slice(0, 4000), sender_item_id: i.itemId })),
      },
      idempotent: true,
    });
    const batchId = res.data.batch_header?.payout_batch_id;
    if (!batchId) throw new ProviderHttpError('paypal returned no payout batch id', { status: res.status, phase: 'ambiguous', body: res.data });
    return { receipt: { providerRequestId: res.requestId, providerObjectId: batchId, httpStatus: res.status, responseSha256: res.sha256, observedAt: ctx.now().toISOString(), details: { batchStatus: res.data.batch_header?.batch_status ?? null } }, beforeState: null, rawResponse: res.data };
  },
  async verify(ctx, p, receipt) {
    const b = await paypalReadBatch(ctx, receipt.providerObjectId!);
    const observed = { status: b.status, items: b.items.length };
    if (b.status === 'paid') return compareProof('reconciliation', { status: 'paid', items: p.items.length }, observed, ctx.now());
    if (b.status === 'pending' || b.status === 'processing') return proof('PENDING', 'reconciliation', { status: 'paid' }, observed, ctx.now(), `batch ${b.raw}`);
    return proof('MISMATCH', 'reconciliation', { status: 'paid' }, observed, ctx.now(), `batch ${b.raw}`);
  },
};

export const paypalRead: ReadConnector = {
  provider: 'paypal',
  async healthCheck(ctx): Promise<HealthResult> {
    try {
      await accessToken(ctx);
      return { healthy: true, status: 'healthy', grantedScopes: null, details: { environment: creds(ctx).environment, note: 'credentials accepted; payout execution stays disabled until creator.payout is enabled (B-015)' } };
    } catch (err) {
      const e = err as ProviderHttpError;
      return { healthy: false, status: e.isAuthError ? 'failing' : 'degraded', grantedScopes: null, details: { error: e.message } };
    }
  },
};
