import { shopifyListProducts } from '@futuregrow/connectors';
import { brandChannels, brands, claims, connections, type DbOrTx, evidenceRecords, kgEntities, type Tx, withTenant } from '@futuregrow/db';
import { conflict, invalid, notFound, sha256Canonical } from '@futuregrow/observability';
import { and, arrayOverlaps, asc, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, requireRole } from '../../util.js';
import { readContext } from '../connections.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { upsertEntity } from '../m03-knowledge/index.js';

/** Scopes the catalog needs on the Shopify custom app (read-only). */
export const CATALOG_SCOPES = ['read_products', 'read_inventory'] as const;
/** Inventory is a point-in-time observation: after this many hours the catalog is shown as stale. */
export const CATALOG_FRESHNESS_HOURS = 24;
const KEY_PREFIX = 'shopify:product:';
const EDIT_ROLES = ['owner', 'admin', 'growth_operator'] as const;

const productKey = (gid: string) =>
  `${KEY_PREFIX}${gid
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')}`;

/**
 * Shopify product and inventory context (P2-09, read-only). Active products, prices and stock
 * become versioned product facts (M03) backed by one evidence snapshot of the shop, so content,
 * offers and the Growth Brain can state availability and price only from the shop's own data.
 * Inventory is a point-in-time observation with a short freshness window.
 *
 * A product whose title and attributes did not change keeps its current fact (no new version per
 * sync); the snapshot still records that it was present. Brands that reference a superseded
 * version of a product are moved to the new version, so a re-sync never breaks a brand link.
 */
export async function syncShopifyCatalog(deps: CoreDeps, tenantId: string, connectionId: string, opts: { actor?: Actor } = {}) {
  const actor = opts.actor ?? systemActor('shopify-catalog');
  if (opts.actor) requireRole(opts.actor, [...EDIT_ROLES], 'syncing the product catalog');
  const { ctx, connection } = await readContext(deps, tenantId, connectionId, 'shopify');
  const { products, currency } = await shopifyListProducts(ctx);
  const now = deps.clock.now();
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const ev = await admitInternalEvidence(t, tenantId, actor, {
      kind: 'snapshot',
      sourceType: 'primary',
      owner: 'shopify',
      uri: `shopify://${connection.externalAccountId}/products@${now.toISOString()}`,
      content: { shop: connection.externalAccountId, connectionId, currency, products: products.map((p) => ({ id: p.id, title: p.title, handle: p.handle, totalInventory: p.totalInventory, variants: p.variants })) },
      summary: `${products.length} active products from ${connection.externalAccountId}`,
      confidence: 1,
      license: 'Shopify Admin API (shop owner data)',
      permittedUses: ['analytics', 'creative_generation', 'autonomous_execution'],
      externalPlatformTerms: 'shopify_api',
      freshnessSlaHours: CATALOG_FRESHNESS_HOURS,
      now,
    });
    let facts = 0;
    let unchanged = 0;
    for (const p of products) {
      const key = productKey(p.id);
      const prices = [...new Set(p.variants.map((v) => v.price))];
      const attributes = { source: 'shopify', shop: connection.externalAccountId, handle: p.handle, status: p.status, currency, prices, totalInventory: p.totalInventory, inStock: p.totalInventory === null ? null : p.totalInventory > 0, url: p.onlineStoreUrl, variants: p.variants.length };
      const [current] = await t
        .select()
        .from(kgEntities)
        .where(and(eq(kgEntities.kind, 'product'), eq(kgEntities.key, key), eq(kgEntities.status, 'active')))
        .orderBy(desc(kgEntities.version))
        .limit(1);
      // jsonb reorders keys: compare canonically.
      if (current && current.name === p.title && sha256Canonical(current.attributes) === sha256Canonical(attributes)) {
        unchanged++;
        continue;
      }
      await upsertEntity(t, deps, tenantId, systemActor('shopify-catalog'), { kind: 'product', key, name: p.title, attributes, evidenceId: ev.evidenceId });
      facts++;
    }
    const relinked = await repointBrandProducts(t);
    await audit(t, tenantId, actor, 'offers.catalog.synced', { type: 'connection', id: connectionId }, { products: products.length, facts, unchanged, relinked });
    return { products: products.length, facts, unchanged, relinked, evidenceId: ev.evidenceId, currency };
  });
}

/** Brands pointing at a superseded product version are moved to that product's current version. */
async function repointBrandProducts(t: Tx): Promise<number> {
  const r = await t.execute(sql`
    with stale as (
      select b.id as brand_id, e.id as old_id, cur.id as new_id
      from brands b
      cross join lateral unnest(b.product_entity_ids) as ref(id)
      join kg_entities e on e.id = ref.id and e.kind = 'product' and e.status = 'superseded'
      join lateral (
        select c.id from kg_entities c where c.kind = 'product' and c.key = e.key and c.status = 'active'
        order by c.version desc limit 1
      ) cur on true
    ), updated as (
      update brands b set product_entity_ids = (
        select array_agg(distinct coalesce(s.new_id, ref.id)) from unnest(b.product_entity_ids) as ref(id)
        left join stale s on s.brand_id = b.id and s.old_id = ref.id
      ), version = b.version + 1, updated_by = 'system:shopify-catalog', updated_at = now()
      where b.id in (select brand_id from stale)
      returning b.id
    )
    select count(*)::int as n from updated`);
  return Number((r.rows[0] as { n?: number } | undefined)?.n ?? 0);
}

/* ------------------------------------------------------------------ */
/* Catalog reads (Channels › Product catalog)                          */
/* ------------------------------------------------------------------ */

interface ProductAttributes {
  shop?: string;
  handle?: string;
  status?: string;
  currency?: string;
  prices?: string[];
  totalInventory?: number | null;
  inStock?: boolean | null;
  url?: string | null;
  variants?: number;
}

interface SnapshotContent {
  shop?: string;
  connectionId?: string;
  products?: { id: string }[];
}

async function latestSnapshots(t: DbOrTx) {
  const rows = await t
    .select({ id: evidenceRecords.id, observedAt: evidenceRecords.observedAt, retrievedAt: evidenceRecords.retrievedAt, content: evidenceRecords.content, summary: evidenceRecords.summary, status: evidenceRecords.status })
    .from(evidenceRecords)
    .where(and(eq(evidenceRecords.sourceOwner, 'shopify'), eq(evidenceRecords.kind, 'snapshot'), like(evidenceRecords.sourceUriOrObjectId, 'shopify://%/products@%')))
    .orderBy(desc(evidenceRecords.retrievedAt))
    .limit(200);
  const byShop = new Map<string, (typeof rows)[number] & { productKeys: Set<string> }>();
  for (const r of rows) {
    const c = (r.content ?? {}) as SnapshotContent;
    if (!c.shop || byShop.has(c.shop)) continue;
    byShop.set(c.shop, { ...r, productKeys: new Set((c.products ?? []).map((p) => productKey(p.id))) });
  }
  return byShop;
}

/** Which brands reference any version of each product key (links survive re-syncs by key). */
async function brandsByProductKey(t: DbOrTx) {
  const all = await t.select({ id: brands.id, name: brands.name, version: brands.version, productEntityIds: brands.productEntityIds }).from(brands).orderBy(asc(brands.name));
  const ids = [...new Set(all.flatMap((b) => b.productEntityIds))];
  const keyOf = new Map<string, string>();
  if (ids.length) for (const e of await t.select({ id: kgEntities.id, key: kgEntities.key }).from(kgEntities).where(inArray(kgEntities.id, ids))) keyOf.set(e.id, e.key);
  const out = new Map<string, { id: string; name: string }[]>();
  for (const b of all) {
    for (const key of new Set(b.productEntityIds.map((id) => keyOf.get(id)).filter((k): k is string => Boolean(k)))) {
      out.set(key, [...(out.get(key) ?? []), { id: b.id, name: b.name }]);
    }
  }
  return { byKey: out, all };
}

/**
 * Shops, their sync state, permission and brand, and every current Shopify product fact with
 * price, stock, freshness and the brands it is linked to. Reads only; calls no provider.
 */
export async function catalogOverview(t: DbOrTx, now: Date) {
  const shops = await t.select().from(connections).where(eq(connections.provider, 'shopify')).orderBy(asc(connections.displayName));
  const owners = shops.length
    ? await t
        .select({ connectionId: brandChannels.connectionId, brandId: brands.id, name: brands.name })
        .from(brandChannels)
        .innerJoin(brands, eq(brands.id, brandChannels.brandId))
        .where(
          inArray(
            brandChannels.connectionId,
            shops.map((s) => s.id),
          ),
        )
    : [];
  const snapshots = await latestSnapshots(t);
  const facts = await t
    .select()
    .from(kgEntities)
    .where(and(eq(kgEntities.kind, 'product'), like(kgEntities.key, `${KEY_PREFIX}%`), inArray(kgEntities.status, ['active', 'conflict'])))
    .orderBy(asc(kgEntities.name), desc(kgEntities.version));
  const { byKey } = await brandsByProductKey(t);
  const staleAfter = CATALOG_FRESHNESS_HOURS * 3_600_000;
  const connectionsOut = shops.map((s) => {
    const snap = snapshots.get(s.externalAccountId);
    const at = snap ? (snap.observedAt ?? snap.retrievedAt) : null;
    const missingScopes = s.grantedScopes.length ? CATALOG_SCOPES.filter((sc) => !s.grantedScopes.includes(sc)) : [];
    const owner = owners.find((o) => o.connectionId === s.id);
    return {
      id: s.id,
      displayName: s.displayName,
      shop: s.externalAccountId,
      status: s.status,
      healthStatus: s.healthStatus,
      lastHealthCheckAt: s.lastHealthCheckAt?.toISOString() ?? null,
      /** Scopes Shopify reported; empty means the token's scopes were not recorded (checked on sync). */
      grantedScopes: s.grantedScopes,
      missingScopes,
      brand: owner ? { id: owner.brandId, name: owner.name } : null,
      lastSync: snap && at ? { at: at.toISOString(), evidenceId: snap.id, products: snap.productKeys.size, stale: now.getTime() - at.getTime() > staleAfter } : null,
      canSync: s.status === 'active' || s.status === 'read_only',
    };
  });
  const seen = new Set<string>();
  const products = [];
  for (const f of facts) {
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    const a = f.attributes as ProductAttributes;
    const shop = a.shop ?? [...snapshots.entries()].find(([, s]) => s.productKeys.has(f.key))?.[0] ?? null;
    const snap = shop ? snapshots.get(shop) : undefined;
    const conn = shop ? shops.find((s) => s.externalAccountId === shop) : undefined;
    const observedAt = snap ? (snap.observedAt ?? snap.retrievedAt) : f.validFrom;
    products.push({
      id: f.id,
      key: f.key,
      name: f.name,
      version: f.version,
      factStatus: f.status,
      shop,
      connectionId: conn?.id ?? null,
      productStatus: a.status ?? null,
      currency: a.currency ?? null,
      prices: a.prices ?? [],
      totalInventory: a.totalInventory ?? null,
      inStock: a.inStock ?? null,
      url: a.url ?? null,
      variants: a.variants ?? null,
      /** False when the latest snapshot of the shop no longer lists the product (archived, draft or deleted in Shopify). */
      inLatestSync: snap ? snap.productKeys.has(f.key) : false,
      observedAt: observedAt.toISOString(),
      stale: now.getTime() - observedAt.getTime() > staleAfter,
      brands: byKey.get(f.key) ?? [],
    });
  }
  return {
    asOf: now.toISOString(),
    freshnessHours: CATALOG_FRESHNESS_HOURS,
    requiredScopes: CATALOG_SCOPES,
    connections: connectionsOut,
    products,
    notes: ['Prices and stock come only from the shop’s own Shopify data at the last sync; stock is a point-in-time count and goes stale after 24 hours.', 'Products that are not active in Shopify are not imported. A product missing from the latest sync is kept for history and marked as such.'],
  };
}

/** One product: the current fact, its version history, the evidence behind it, linked brands and approved claims. */
export async function catalogProduct(t: DbOrTx, entityId: string, now: Date) {
  const [f] = await t.select().from(kgEntities).where(eq(kgEntities.id, entityId));
  if (!f || f.kind !== 'product' || !f.key.startsWith(KEY_PREFIX)) throw notFound('product');
  const versions = await t
    .select()
    .from(kgEntities)
    .where(and(eq(kgEntities.kind, 'product'), eq(kgEntities.key, f.key)))
    .orderBy(desc(kgEntities.version))
    .limit(50);
  const current = versions.find((v) => v.status === 'active' || v.status === 'conflict') ?? versions[0]!;
  const evidenceIds = [...new Set(versions.map((v) => v.evidenceId))];
  const evidence = await t
    .select({ id: evidenceRecords.id, observedAt: evidenceRecords.observedAt, retrievedAt: evidenceRecords.retrievedAt, summary: evidenceRecords.summary, uri: evidenceRecords.sourceUriOrObjectId, status: evidenceRecords.status })
    .from(evidenceRecords)
    .where(inArray(evidenceRecords.id, evidenceIds));
  const { byKey } = await brandsByProductKey(t);
  const approved = await t
    .select({ id: claims.id, text: claims.text, regulated: claims.regulated, expiresAt: claims.expiresAt })
    .from(claims)
    .where(
      and(
        eq(claims.status, 'approved'),
        arrayOverlaps(
          claims.entityIds,
          versions.map((v) => v.id),
        ),
      ),
    );
  const a = current.attributes as ProductAttributes;
  const ev = evidence.find((e) => e.id === current.evidenceId);
  const observedAt = ev ? (ev.observedAt ?? ev.retrievedAt) : current.validFrom;
  return {
    product: { id: current.id, key: current.key, name: current.name, version: current.version, factStatus: current.status, attributes: a, observedAt: observedAt.toISOString(), stale: now.getTime() - observedAt.getTime() > CATALOG_FRESHNESS_HOURS * 3_600_000 },
    versions: versions.map((v) => {
      const va = v.attributes as ProductAttributes;
      return { id: v.id, version: v.version, status: v.status, validFrom: v.validFrom.toISOString(), validTo: v.validTo?.toISOString() ?? null, prices: va.prices ?? [], totalInventory: va.totalInventory ?? null, evidenceId: v.evidenceId };
    }),
    evidence: evidence.map((e) => ({ id: e.id, observedAt: (e.observedAt ?? e.retrievedAt).toISOString(), summary: e.summary, uri: e.uri, status: e.status })),
    brands: byKey.get(current.key) ?? [],
    approvedClaims: approved.map((c) => ({ ...c, expiresAt: c.expiresAt?.toISOString() ?? null })),
  };
}

/**
 * Links a product to a brand (or removes the link): the brand's product facts drive grounded
 * content and claim checks for that brand. Stale versions of the same product are replaced by the
 * current one; the brand's optimistic version guards concurrent edits.
 */
export async function setProductBrand(t: Tx, tenantId: string, actor: Actor, entityId: string, input: { brandId: string; linked: boolean; expectedVersion: number }) {
  requireRole(actor, [...EDIT_ROLES], 'linking products to brands');
  const [f] = await t.select().from(kgEntities).where(eq(kgEntities.id, entityId));
  if (!f || f.kind !== 'product') throw notFound('product');
  const [cur] = await t
    .select()
    .from(kgEntities)
    .where(and(eq(kgEntities.kind, 'product'), eq(kgEntities.key, f.key), eq(kgEntities.status, 'active')))
    .orderBy(desc(kgEntities.version))
    .limit(1);
  if (!cur) throw invalid('this product has no current fact (it is superseded or in conflict); sync the catalog first');
  const [b] = await t.select().from(brands).where(eq(brands.id, input.brandId));
  if (!b) throw notFound('brand');
  if (b.version !== input.expectedVersion) throw conflict(`brand changed since version ${input.expectedVersion} (now ${b.version}); reload and try again`);
  const sameKey = b.productEntityIds.length
    ? new Set(
        (
          await t
            .select({ id: kgEntities.id })
            .from(kgEntities)
            .where(and(inArray(kgEntities.id, b.productEntityIds), eq(kgEntities.key, f.key)))
        ).map((r) => r.id),
      )
    : new Set<string>();
  const next = [...b.productEntityIds.filter((id) => !sameKey.has(id)), ...(input.linked ? [cur.id] : [])];
  if (next.length > 50) throw invalid('a brand can reference at most 50 product facts');
  const [row] = await t
    .update(brands)
    .set({ productEntityIds: next, version: b.version + 1, updatedBy: actorRef(actor), updatedAt: new Date() })
    .where(and(eq(brands.id, b.id), eq(brands.version, input.expectedVersion)))
    .returning();
  if (!row) throw conflict('brand changed in the meantime; reload and try again');
  await audit(t, tenantId, actor, input.linked ? 'brand.product_linked' : 'brand.product_unlinked', { type: 'brand', id: b.id }, { productKey: f.key, entityId: cur.id, version: row.version });
  return { brandId: row.id, version: row.version, productEntityIds: row.productEntityIds };
}

/** Daily read-only refresh of every active Shopify connection; one failing shop never stops the others. */
export async function syncAllCatalogs(deps: CoreDeps, tenantId: string) {
  const shops = await withTenant(deps.db, { tenantId, actor: 'system:shopify-catalog' }, (t) =>
    t
      .select({ id: connections.id })
      .from(connections)
      .where(and(eq(connections.provider, 'shopify'), eq(connections.status, 'active'))),
  );
  const out: { connectionId: string; ok: boolean; error?: string }[] = [];
  for (const s of shops) {
    try {
      await syncShopifyCatalog(deps, tenantId, s.id);
      out.push({ connectionId: s.id, ok: true });
    } catch (err) {
      out.push({ connectionId: s.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
