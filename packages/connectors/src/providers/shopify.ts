import { ProviderHttpError, preWrite } from '../http.js';
import { type ActionExecutor, type ConnectorContext, type HealthResult, type ReadConnector, compareProof, proof } from '../types.js';

type ShopCreds = Extract<ConnectorContext['credentials'], { provider: 'shopify' }>;

function creds(ctx: ConnectorContext): ShopCreds {
  if (ctx.credentials.provider !== 'shopify') throw new Error('shopify credentials required');
  return ctx.credentials;
}

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function endpoint(ctx: ConnectorContext): string {
  const c = creds(ctx);
  if (ctx.endpoints.shopifyOverride) return `${ctx.endpoints.shopifyOverride.replace(/\/$/, '')}/admin/api/${ctx.versions.shopify}/graphql.json`;
  if (!SHOP_RE.test(c.shopDomain)) throw new ProviderHttpError(`invalid shop domain ${c.shopDomain}`, { status: null, phase: 'before_send' });
  return `https://${c.shopDomain}/admin/api/${ctx.versions.shopify}/graphql.json`;
}

interface GqlResult<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: { cost?: { throttleStatus?: { currentlyAvailable?: number } } };
}

async function gql<T>(ctx: ConnectorContext, query: string, variables: Record<string, unknown>, idempotent: boolean) {
  const res = await ctx.http.request<GqlResult<T>>({
    method: 'POST',
    url: endpoint(ctx),
    headers: { 'x-shopify-access-token': creds(ctx).accessToken },
    json: { query, variables },
    idempotent,
  });
  if (res.data.errors?.length) {
    const throttled = res.data.errors.some((e) => e.extensions?.code === 'THROTTLED');
    // Top-level GraphQL errors mean the operation did not execute.
    throw new ProviderHttpError(`shopify graphql error: ${res.data.errors.map((e) => e.message).join('; ')}`, {
      status: throttled ? 429 : res.status,
      phase: 'rejected',
      body: res.data,
      retryAfterMs: throttled ? 2000 : null,
    });
  }
  return res;
}

const DISCOUNT_FIELDS = `
  id
  codeDiscount {
    ... on DiscountCodeBasic {
      title
      status
      startsAt
      endsAt
      usageLimit
      codes(first: 1) { nodes { code } }
      customerGets { value { ... on DiscountPercentage { percentage } } }
    }
  }`;

interface DiscountNode {
  id: string;
  codeDiscount?: {
    title?: string;
    status?: string;
    startsAt?: string;
    endsAt?: string | null;
    usageLimit?: number | null;
    codes?: { nodes: { code: string }[] };
    customerGets?: { value?: { percentage?: number } };
  };
}

interface DiscountParams {
  title: string;
  code: string;
  percentage: number;
  startsAt: string;
  endsAt: string | null;
  usageLimit: number | null;
}

async function findByCode(ctx: ConnectorContext, code: string): Promise<DiscountNode | null> {
  const r = await gql<{ codeDiscountNodeByCode: DiscountNode | null }>(
    ctx,
    `query($code: String!) { codeDiscountNodeByCode(code: $code) { ${DISCOUNT_FIELDS} } }`,
    { code },
    true,
  );
  return r.data.data?.codeDiscountNodeByCode ?? null;
}

export const shopifyCreateDiscount: ActionExecutor<DiscountParams> = {
  actionType: 'commerce.shopify.create_discount',
  provider: 'shopify',
  async execute(ctx, p) {
    // Idempotency without provider keys: codes are unique per shop, so look before create.
    const existing = await preWrite(() => findByCode(ctx, p.code));
    if (existing) {
      throw new ProviderHttpError(`discount code ${p.code} already exists (${existing.id}); refusing to overwrite`, { status: null, phase: 'rejected', body: existing });
    }
    const res = await gql<{ discountCodeBasicCreate: { codeDiscountNode: DiscountNode | null; userErrors: { field?: string[]; code?: string; message: string }[] } }>(
      ctx,
      `mutation($input: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount: $input) {
          codeDiscountNode { ${DISCOUNT_FIELDS} }
          userErrors { field code message }
        }
      }`,
      {
        input: {
          title: p.title,
          code: p.code,
          startsAt: p.startsAt,
          endsAt: p.endsAt,
          usageLimit: p.usageLimit,
          appliesOncePerCustomer: true,
          context: { all: 'ALL' },
          customerGets: { value: { percentage: p.percentage }, items: { all: true } },
        },
      },
      false,
    );
    const payload = res.data.data?.discountCodeBasicCreate;
    if (payload?.userErrors?.length) {
      throw new ProviderHttpError(`shopify rejected discount: ${payload.userErrors.map((e) => e.message).join('; ')}`, { status: res.status, phase: 'rejected', body: payload });
    }
    const node = payload?.codeDiscountNode;
    if (!node?.id) throw new ProviderHttpError('shopify returned no discount node', { status: res.status, phase: 'ambiguous', body: res.data });
    return {
      receipt: { providerRequestId: res.requestId, providerObjectId: node.id, httpStatus: res.status, responseSha256: res.sha256, observedAt: ctx.now().toISOString(), details: {} },
      beforeState: null,
      rawResponse: res.data,
    };
  },
  async verify(ctx, p) {
    const node = await findByCode(ctx, p.code);
    if (!node) return proof('PENDING', 'read_after_write', { exists: true }, { exists: false }, ctx.now());
    const d = node.codeDiscount ?? {};
    return compareProof(
      'read_after_write',
      { title: p.title, code: p.code, percentage: p.percentage, usageLimit: p.usageLimit },
      { title: d.title, code: d.codes?.nodes[0]?.code, percentage: d.customerGets?.value?.percentage, usageLimit: d.usageLimit ?? null, status: d.status },
      ctx.now(),
    );
  },
  async rollback(ctx, _p, receipt) {
    const res = await gql<{ discountCodeDeactivate: { userErrors: { message: string }[] } }>(
      ctx,
      'mutation($id: ID!) { discountCodeDeactivate(id: $id) { codeDiscountNode { id } userErrors { field code message } } }',
      { id: receipt.providerObjectId },
      true,
    );
    return {
      receipt: { providerRequestId: res.requestId, providerObjectId: receipt.providerObjectId, httpStatus: res.status, responseSha256: res.sha256, observedAt: ctx.now().toISOString(), details: { rollback: 'deactivate' } },
      beforeState: null,
      rawResponse: res.data,
    };
  },
  async verifyRollback(ctx, p) {
    const node = await findByCode(ctx, p.code);
    const status = node?.codeDiscount?.status ?? null;
    return status === 'EXPIRED' || node === null
      ? proof('VERIFIED', 'read_after_write', { active: false }, { status }, ctx.now())
      : proof('MISMATCH', 'read_after_write', { active: false }, { status }, ctx.now());
  },
};

export const shopifyRead: ReadConnector = {
  provider: 'shopify',
  async healthCheck(ctx): Promise<HealthResult> {
    try {
      const r = await gql<{ shop: { name: string; currencyCode: string }; currentAppInstallation?: { accessScopes: { handle: string }[] } }>(
        ctx,
        '{ shop { name currencyCode } currentAppInstallation { accessScopes { handle } } }',
        {},
        true,
      );
      return {
        healthy: true,
        status: 'healthy',
        grantedScopes: r.data.data?.currentAppInstallation?.accessScopes.map((s) => s.handle) ?? null,
        details: { shop: r.data.data?.shop.name, currency: r.data.data?.shop.currencyCode },
      };
    } catch (err) {
      const e = err as ProviderHttpError;
      return { healthy: false, status: e.isAuthError ? 'failing' : 'degraded', grantedScopes: null, details: { error: e.message } };
    }
  },
};
