// lib/woocommerce.js — minimal WooCommerce REST v3 adapter for G25 (website stock sync).
//
// Only two calls, on purpose: find a product by SKU, and PUT a small update to it. The
// sync never touches price, title, description, images or backorder settings — the update
// body is built in lib/wooStock.js buildWooUpdate() and contains stock + the sold-out fields
// only.
//
// Credentials (owner creates them; the agent never handles keys):
//   WOO_BASE_URL         e.g. https://<staging site>  (Preview = Cloudways STAGING only)
//   WOO_CONSUMER_KEY     REST key for the dedicated `portal-stock-sync` Shop Manager user
//   WOO_CONSUMER_SECRET
// Sent as HTTP Basic auth over HTTPS — never in the URL.

const TIMEOUT_MS = 10000;

export function wooConfigured(env = process.env) {
  return Boolean(env?.WOO_BASE_URL && env?.WOO_CONSUMER_KEY && env?.WOO_CONSUMER_SECRET);
}

function slim(p) {
  if (!p) return null;
  return { id: p.id, sku: p.sku, stock_quantity: p.stock_quantity ?? null, manage_stock: p.manage_stock, status: p.status };
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
      throw new Error(`Website returned ${r.status}${detail ? `: ${detail}` : ''}`);
    }
    return r.json();
  }

  return {
    async findProductBySku(sku) {
      // status=any so a pending / private product is still found (it is the same listing).
      const list = await call(`/products?sku=${encodeURIComponent(sku)}&status=any`);
      return Array.isArray(list) && list.length ? slim(list[0]) : null;
    },
    async updateProduct(id, body) {
      return call(`/products/${Number(id)}`, { method: 'PUT', body: JSON.stringify(body) });
    },
  };
}
