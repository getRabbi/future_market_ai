import { useMemo, useState } from 'react';
import { api, type Me } from '../lib/api.js';
import { formatDay, relativeTime } from '../lib/format.js';
import { Ico } from './Icons.js';
import { Badge, Drawer, EmptyState, ErrorNotice, LoadingRows, useApi } from './ui.js';

/** Every API call this screen makes (checked against the API's routes in catalog.test.ts). */
export const CATALOG_CALLS = [
  { method: 'GET', path: '/v1/offers/catalog' },
  { method: 'GET', path: '/v1/offers/catalog/products/:id' },
  { method: 'PUT', path: '/v1/offers/catalog/products/:id/brand' },
  { method: 'POST', path: '/v1/offers/connections/:id/catalog/sync' },
  { method: 'GET', path: '/v1/brands' },
] as const;

interface Shop {
  id: string;
  displayName: string;
  shop: string;
  status: string;
  healthStatus: string;
  lastHealthCheckAt: string | null;
  grantedScopes: string[];
  missingScopes: string[];
  brand: { id: string; name: string } | null;
  lastSync: { at: string; evidenceId: string; products: number; stale: boolean } | null;
  canSync: boolean;
}
interface Product {
  id: string;
  key: string;
  name: string;
  version: number;
  factStatus: string;
  shop: string | null;
  connectionId: string | null;
  productStatus: string | null;
  currency: string | null;
  prices: string[];
  totalInventory: number | null;
  inStock: boolean | null;
  url: string | null;
  variants: number | null;
  inLatestSync: boolean;
  observedAt: string;
  stale: boolean;
  brands: { id: string; name: string }[];
}
interface Catalog {
  asOf: string;
  freshnessHours: number;
  requiredScopes: string[];
  connections: Shop[];
  products: Product[];
  notes: string[];
}
interface BrandRow {
  id: string;
  name: string;
  version: number;
  productEntityIds: string[];
}
interface ProductDetail {
  product: { id: string; key: string; name: string; version: number; factStatus: string; attributes: Record<string, unknown>; observedAt: string; stale: boolean };
  versions: { id: string; version: number; status: string; validFrom: string; validTo: string | null; prices: string[]; totalInventory: number | null }[];
  evidence: { id: string; observedAt: string; summary: string | null; status: string }[];
  brands: { id: string; name: string }[];
  approvedClaims: { id: string; text: string; regulated: boolean; expiresAt: string | null }[];
}

const EDIT_ROLES = ['owner', 'admin', 'growth_operator'];
const price = (p: Product) => (p.prices.length ? `${p.prices.length > 1 ? `${p.prices[0]}–${p.prices.at(-1)}` : p.prices[0]} ${p.currency ?? ''}`.trim() : 'No price');
const stock = (p: { inStock: boolean | null; totalInventory: number | null }) => (p.totalInventory === null ? 'Not tracked' : p.inStock ? `${p.totalInventory} in stock` : 'Out of stock');

/**
 * Channels › Product catalog (P2-09): the Shopify products and stock FUTUREGROW may cite, where
 * each came from and when, which brand each belongs to, and whether a shop can be synced.
 */
export function ProductCatalog({ me }: { me: Me }) {
  const catalog = useApi<Catalog>('/v1/offers/catalog');
  const brandList = useApi<BrandRow[]>('/v1/brands');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [shop, setShop] = useState('');
  const [brand, setBrand] = useState('');
  const [stockFilter, setStockFilter] = useState<'all' | 'in' | 'out'>('all');
  const [showRemoved, setShowRemoved] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const canEdit = me.roles.some((r) => EDIT_ROLES.includes(r));

  const sync = async (s: Shop) => {
    setError(null);
    setNotice(null);
    setBusy(s.id);
    try {
      const r = await api<{ products: number; facts: number; unchanged: number }>('POST', `/v1/offers/connections/${s.id}/catalog/sync`);
      setNotice(`${s.displayName}: ${r.products} active product${r.products === 1 ? '' : 's'} read; ${r.facts} new or changed, ${r.unchanged} unchanged.`);
      await catalog.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const products = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (catalog.data?.products ?? []).filter(
      (p) =>
        (!term || `${p.name} ${p.key}`.toLowerCase().includes(term)) &&
        (!shop || p.connectionId === shop) &&
        (!brand || (brand === 'none' ? p.brands.length === 0 : p.brands.some((b) => b.id === brand))) &&
        (stockFilter === 'all' || (stockFilter === 'in' ? p.inStock === true : p.inStock === false)) &&
        (showRemoved || p.inLatestSync),
    );
  }, [catalog.data, q, shop, brand, stockFilter, showRemoved]);

  if (catalog.error) return <ErrorNotice error={catalog.error} />;
  if (!catalog.data) return <LoadingRows label="Loading the product catalog…" />;
  const data = catalog.data;
  const removed = data.products.filter((p) => !p.inLatestSync).length;

  return (
    <div className="stack">
      <section className="card" aria-labelledby="cat-shops">
        <header className="card-head">
          <h2 className="card-title" id="cat-shops">
            <Ico name="tag" size={19} /> Shops
          </h2>
          <span className="small muted">Read-only: products, prices and stock. Synced daily; inventory goes stale after {data.freshnessHours} hours.</span>
        </header>
        <ErrorNotice error={error} />
        {notice ? (
          <p className="notice small" role="status">
            {notice}
          </p>
        ) : null}
        {data.connections.length ? (
          <ul className="row-list">
            {data.connections.map((s) => (
              <li key={s.id} className="row-item">
                <div className="row">
                  <div>
                    <strong>{s.displayName}</strong> <span className="small muted">{s.shop}</span>
                    <div className="small">
                      {s.brand ? (
                        <>
                          Brand: <a href="/app/channels">{s.brand.name}</a>
                        </>
                      ) : (
                        <span className="muted">
                          Not linked to a brand — <a href="/app/channels">link it in Channels & Accounts</a>
                        </span>
                      )}
                      {' · '}
                      {s.lastSync ? `Last sync ${relativeTime(s.lastSync.at)} (${s.lastSync.products} active products)` : 'Never synced'}
                    </div>
                    {s.missingScopes.length ? (
                      <p className="notice small" role="status">
                        The Shopify app token is missing {s.missingScopes.join(' and ')}. Add {s.missingScopes.length === 1 ? 'that scope' : 'those scopes'} to the custom app, reinstall it and update the token in Connections; until then stock may be missing.
                      </p>
                    ) : null}
                    {s.status !== 'active' ? <p className="small muted">This connection is {s.status.replace('_', ' ')}; sync is unavailable until it is active.</p> : null}
                  </div>
                  <div className="row-actions">
                    <Badge value={s.status} />
                    {s.healthStatus !== 'unknown' ? <Badge value={s.healthStatus} /> : null}
                    {s.lastSync?.stale ? <Badge value="stale" /> : null}
                    {canEdit && s.canSync ? (
                      <button type="button" className="small-btn" disabled={busy !== null} onClick={() => void sync(s)}>
                        {busy === s.id ? 'Syncing…' : 'Sync now'}
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No Shopify store connected"
            action={
              <a className="btn" href="/app/connections">
                Open Connections & Credentials
              </a>
            }
          >
            Create a Shopify custom app with the {data.requiredScopes.join(' and ')} scopes (plus read_orders and write_discounts for orders and offers), then connect it with its Admin API token. FUTUREGROW only reads the catalog; it never changes products or prices.
          </EmptyState>
        )}
      </section>

      {data.connections.length || data.products.length ? (
        <section className="card" aria-labelledby="cat-products">
          <header className="card-head">
            <h2 className="card-title" id="cat-products">
              Products
            </h2>
            <span className="small muted">
              {data.products.length - removed} active{removed ? ` · ${removed} no longer in the shop` : ''}
            </span>
          </header>
          <div className="toolbar">
            <label className="filter-box">
              <Ico name="search" size={17} />
              <span className="sr-only">Filter products</span>
              <input type="search" placeholder="Filter by product name" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            {data.connections.length > 1 ? (
              <label className="mini-select">
                <span className="sr-only">Shop</span>
                <select value={shop} onChange={(e) => setShop(e.target.value)}>
                  <option value="">All shops</option>
                  {data.connections.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.displayName}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="mini-select">
              <span className="sr-only">Brand</span>
              <select value={brand} onChange={(e) => setBrand(e.target.value)}>
                <option value="">All brands</option>
                <option value="none">No brand</option>
                {(brandList.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="mini-select">
              <span className="sr-only">Stock</span>
              <select value={stockFilter} onChange={(e) => setStockFilter(e.target.value as 'all' | 'in' | 'out')}>
                <option value="all">Any stock</option>
                <option value="in">In stock</option>
                <option value="out">Out of stock</option>
              </select>
            </label>
            {removed ? (
              <label className="small">
                <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} /> Show products no longer in the shop
              </label>
            ) : null}
          </div>
          {products.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Product</th>
                    <th scope="col">Price</th>
                    <th scope="col">Stock</th>
                    <th scope="col">Brand</th>
                    <th scope="col">As of</th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((p) => (
                    <tr key={p.id}>
                      <td data-label="Product">
                        <button type="button" className="link-btn" onClick={() => setOpen(p.id)}>
                          {p.name}
                        </button>
                        {p.variants && p.variants > 1 ? <span className="small muted"> · {p.variants} variants</span> : null}
                      </td>
                      <td data-label="Price">{price(p)}</td>
                      <td data-label="Stock">{stock(p)}</td>
                      <td data-label="Brand">{p.brands.length ? p.brands.map((b) => b.name).join(', ') : <span className="muted">None</span>}</td>
                      <td data-label="As of">{relativeTime(p.observedAt)}</td>
                      <td data-label="State">
                        {!p.inLatestSync ? <Badge value="removed" /> : p.stale ? <Badge value="stale" /> : <Badge value="current" />}
                        {p.factStatus === 'conflict' ? <Badge value="conflict" /> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : data.products.length ? (
            <p className="small muted">No product matches these filters.</p>
          ) : (
            <EmptyState title="No products imported yet">{canEdit ? 'Use “Sync now” on a shop to import its active products.' : 'An owner, admin or growth operator can sync the shop.'}</EmptyState>
          )}
          <ul className="small muted">
            {data.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {open ? (
        <ProductDrawer
          id={open}
          canEdit={canEdit}
          brands={brandList.data ?? []}
          onClose={() => setOpen(null)}
          onChanged={() => {
            void catalog.reload();
            void brandList.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function ProductDrawer({ id, canEdit, brands, onClose, onChanged }: { id: string; canEdit: boolean; brands: BrandRow[]; onClose: () => void; onChanged: () => void }) {
  const detail = useApi<ProductDetail>(`/v1/offers/catalog/products/${id}`);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toggle = async (b: BrandRow, linked: boolean) => {
    setError(null);
    setBusy(b.id);
    try {
      await api('PUT', `/v1/offers/catalog/products/${id}/brand`, { brandId: b.id, linked, expectedVersion: b.version });
      onChanged();
      await detail.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const d = detail.data;
  const a = (d?.product.attributes ?? {}) as { prices?: string[]; currency?: string; totalInventory?: number | null; inStock?: boolean | null; url?: string | null; handle?: string; variants?: number; shop?: string };
  return (
    <Drawer title={d?.product.name ?? 'Product'} onClose={onClose}>
      {detail.error ? <ErrorNotice error={detail.error} /> : null}
      {!d ? (
        <LoadingRows />
      ) : (
        <div className="stack">
          <div className="kv">
            <div className="kv-row">
              <span>Price</span>
              <strong>{a.prices?.length ? `${a.prices.join(', ')} ${a.currency ?? ''}` : 'No price'}</strong>
            </div>
            <div className="kv-row">
              <span>Stock</span>
              <strong>{stock({ inStock: a.inStock ?? null, totalInventory: a.totalInventory ?? null })}</strong>
            </div>
            <div className="kv-row">
              <span>Variants</span>
              <strong>{a.variants ?? '—'}</strong>
            </div>
            <div className="kv-row">
              <span>Shop</span>
              <strong>{a.shop ?? '—'}</strong>
            </div>
            <div className="kv-row">
              <span>Observed</span>
              <strong>
                {relativeTime(d.product.observedAt)}
                {d.product.stale ? ' (stale)' : ''}
              </strong>
            </div>
          </div>
          {a.url ? (
            <p className="small">
              <a href={a.url} target="_blank" rel="noreferrer noopener">
                Open the product page
              </a>
            </p>
          ) : (
            <p className="small muted">Not published to the online store.</p>
          )}
          <section aria-labelledby="pd-brands">
            <h3 id="pd-brands">Brands</h3>
            <p className="small muted">A brand’s products ground its content and claim checks. Linking never changes anything in Shopify.</p>
            <ErrorNotice error={error} />
            {brands.length ? (
              <ul className="row-list">
                {brands.map((b) => {
                  const linked = d.brands.some((x) => x.id === b.id);
                  return (
                    <li key={b.id} className="row-item">
                      <div className="row">
                        <span>{b.name}</span>
                        <div className="row-actions">
                          {linked ? <Badge value="linked" /> : null}
                          {canEdit ? (
                            <button type="button" className="small-btn" disabled={busy !== null || d.product.factStatus !== 'active'} onClick={() => void toggle(b, !linked)}>
                              {linked ? 'Unlink' : 'Link to this brand'}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="small muted">
                No brands yet. <a href="/app/channels">Create a brand</a> first.
              </p>
            )}
          </section>
          <section aria-labelledby="pd-claims">
            <h3 id="pd-claims">Approved claims</h3>
            {d.approvedClaims.length ? (
              <ul className="small">
                {d.approvedClaims.map((c) => (
                  <li key={c.id}>
                    {c.text}
                    {c.regulated ? ' (regulated)' : ''}
                    {c.expiresAt ? ` · expires ${relativeTime(c.expiresAt)}` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">
                No approved claim refers to this product. <a href="/app/knowledge">Knowledge & claims</a>
              </p>
            )}
          </section>
          <section aria-labelledby="pd-history">
            <h3 id="pd-history">History</h3>
            <p className="small muted">A new version is recorded only when the title, price, stock or status changed.</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    <th scope="col">From</th>
                    <th scope="col">Price</th>
                    <th scope="col">Stock</th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {d.versions.map((v) => (
                    <tr key={v.id}>
                      <td data-label="Version">{v.version}</td>
                      <td data-label="From">{formatDay(v.validFrom.slice(0, 10))}</td>
                      <td data-label="Price">{v.prices.join(', ') || '—'}</td>
                      <td data-label="Stock">{v.totalInventory ?? '—'}</td>
                      <td data-label="State">
                        <Badge value={v.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted">
              Evidence: {d.evidence.length} Shopify snapshot{d.evidence.length === 1 ? '' : 's'} (<a href="/app/evidence">Evidence</a>).
            </p>
          </section>
        </div>
      )}
    </Drawer>
  );
}
