// lib/woocommerce.js — minimal WooCommerce REST v3 adapter for G25 (website stock sync).
//
// Only two calls, on purpose: find a product by SKU (with its ACF meta, so the Sold flag is
// known — G25e1), and PUT a small update to it. The sync never touches price, title,
// description, images or backorder settings — the update body is built in lib/wooStock.js
// buildWooUpdate() and contains stock + the sold-out / back-in-stock fields only.
//
// Credentials (owner creates them; the agent never handles keys):
//   WOO_BASE_URL         e.g. https://<staging site>  (Preview = Cloudways STAGING only)
//   WOO_CONSUMER_KEY     REST key for the dedicated `portal-stock-sync` Shop Manager user
//   WOO_CONSUMER_SECRET
// Sent as HTTP Basic auth over HTTPS — never in the URL.

const TIMEOUT_MS = 5000; // per call; the whole sync also has a time budget (lib/wooStock.js)

export function wooConfigured(env = process.env) {
  return Boolean(env?.WOO_BASE_URL && env?.WOO_CONSUMER_KEY && env?.WOO_CONSUMER_SECRET);
}

// G25e1: the ACF "Sold" flag lives in meta_data (key `sold`, stored "1"/"0"); the back-in-stock
// treatment needs it. Absent meta_data (e.g. a `_fields` list) → sold: undefined.
export function acfSold(metaData) {
  if (!Array.isArray(metaData)) return undefined;
  const m = metaData.find((x) => x && x.key === 'sold');
  if (!m) return false;
  const v = String(m.value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function slim(p) {
  if (!p) return null;
  const out = { id: p.id, sku: p.sku, stock_quantity: p.stock_quantity ?? null, manage_stock: p.manage_stock, status: p.status };
  const sold = acfSold(p.meta_data);
  if (sold !== undefined) out.sold = sold;
  return out;
}

export function createWooClient({ env = process.env, fetch = globalThis.fetch } = {}) {
  if (!wooConfigured(env)) throw new Error('WooCommerce keys are not set up yet');
  const base = String(env.WOO_BASE_URL).replace(/\/+$/, '') + '/wp-json/wc/v3';
  const auth = 'Basic ' + Buffer.from(`${env.WOO_CONSUMER_KEY}:${env.WOO_CONSUMER_SECRET}`).toString('base64');

  async function call(path, init = {}) {
    let r;
    try {
      r = await fetch(base + path, {
        ...init,
        headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
      });
    } catch (err) {
      throw new Error(err?.name === 'TimeoutError' ? 'Website timed out' : `Website not reachable (${err?.message || err})`);
    }
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.json())?.message || ''; } catch {}
      const e = new Error(`Website returned ${r.status}${detail ? `: ${detail}` : ''}`);
      e.status = r.status;
      throw e;
    }
    return r.json();
  }

  return {
    async findProductBySku(sku) {
      // status=any so a pending / private product is still found (it is the same listing).
      const list = await call(`/products?sku=${encodeURIComponent(sku)}&status=any`);
      return Array.isArray(list) && list.length ? slim(list[0]) : null;
    },
    // G25c: READ up to 100 SKUs in one GET (the Products "Website stock" column and the weekly
    // drift report). Callers batch with lib/websiteStockView.js chunkSkus(); never per row.
    async findProductsBySkus(skus) {
      const list = (skus || []).map(String).filter(Boolean).slice(0, 100);
      if (!list.length) return [];
      const q = `sku=${encodeURIComponent(list.join(','))}&status=any&per_page=100&_fields=id,sku,stock_quantity,manage_stock,status`;
      const rows = await call(`/products?${q}`);
      return Array.isArray(rows) ? rows.map(slim) : [];
    },
    async updateProduct(id, body) {
      return call(`/products/${Number(id)}`, { method: 'PUT', body: JSON.stringify(body) });
    },
    // G25e2 (E-D8): a SKU that isn't on the website yet becomes a DRAFT for the owner to review.
    // SKU, portal name and stock only — no price, no images, no description (photos must be real
    // ones, added by hand while reviewing). Never published from here.
    async createDraftProduct({ sku, name, stock }) {
      const body = { name: String(name || sku), sku: String(sku), status: 'draft', manage_stock: true, stock_quantity: Number(stock) };
      return call('/products', { method: 'POST', body: JSON.stringify(body) });
    },
  };
}
