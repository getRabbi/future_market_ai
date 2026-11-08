import { shopifyListProducts } from '@futuregrow/connectors';
import { withTenant } from '@futuregrow/db';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, requireRole } from '../../util.js';
import { readContext } from '../connections.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { upsertEntity } from '../m03-knowledge/index.js';

/**
 * Shopify product and inventory context (P2-09, read-only). Active products, prices and stock
 * become versioned product facts (M03) backed by one evidence snapshot of the shop, so content,
 * offers and the Growth Brain can state availability and price only from the shop's own data.
 * Inventory is a point-in-time observation with a short freshness window.
 */
export async function syncShopifyCatalog(deps: CoreDeps, tenantId: string, connectionId: string, opts: { actor?: Actor } = {}) {
  const actor = opts.actor ?? systemActor('shopify-catalog');
  if (opts.actor) requireRole(opts.actor, ['owner', 'admin', 'growth_operator'], 'syncing the product catalog');
  const { ctx, connection } = await readContext(deps, tenantId, connectionId, 'shopify');
  const { products, currency } = await shopifyListProducts(ctx);
  const now = deps.clock.now();
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (t) => {
    const ev = await admitInternalEvidence(t, tenantId, actor, {
      kind: 'snapshot',
      sourceType: 'primary',
      owner: 'shopify',
      uri: `shopify://${connection.externalAccountId}/products@${now.toISOString()}`,
      content: { shop: connection.externalAccountId, currency, products: products.map((p) => ({ id: p.id, title: p.title, handle: p.handle, totalInventory: p.totalInventory, variants: p.variants })) },
      summary: `${products.length} active products from ${connection.externalAccountId}`,
      confidence: 1,
      license: 'Shopify Admin API (shop owner data)',
      permittedUses: ['analytics', 'creative_generation', 'autonomous_execution'],
      externalPlatformTerms: 'shopify_api',
      freshnessSlaHours: 24,
      now,
    });
    let facts = 0;
    for (const p of products) {
      const id = p.id
        .split('/')
        .pop()!
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      const prices = [...new Set(p.variants.map((v) => v.price))];
      await upsertEntity(t, deps, tenantId, systemActor('shopify-catalog'), {
        kind: 'product',
        key: `shopify:product:${id}`,
        name: p.title,
        attributes: { source: 'shopify', handle: p.handle, status: p.status, currency, prices, totalInventory: p.totalInventory, inStock: p.totalInventory === null ? null : p.totalInventory > 0, url: p.onlineStoreUrl, variants: p.variants.length },
        evidenceId: ev.evidenceId,
      });
      facts++;
    }
    await audit(t, tenantId, actor, 'offers.catalog.synced', { type: 'connection', id: connectionId }, { products: products.length, facts });
    return { products: products.length, facts, evidenceId: ev.evidenceId, currency };
  });
}
