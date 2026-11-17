// lib/woocommerce.mock.js — in-memory WooCommerce for G25 (Golden Rule 6: mock-first).
// Same shape as createWooClient() in lib/woocommerce.js. Used by the offline smoke and by a
// Preview when WOO_MOCK=true (no keys yet). Nothing here touches a real website.

export function createMockWoo(list = [], { failUpdates = false } = {}) {
  const products = new Map(list.map((p) => [p.id, { meta: {}, ...p }]));
  const mock = {
    products,
    writes: 0,
    async findProductBySku(sku) {
      for (const p of products.values()) if (p.sku === sku) return { id: p.id, sku: p.sku, stock_quantity: p.stock_quantity ?? null, manage_stock: p.manage_stock };
      return null;
    },
    async updateProduct(id, body) {
      if (failUpdates) throw new Error('Website timed out');
      const p = products.get(Number(id));
      if (!p) throw new Error('Website returned 404: Invalid ID.');
      mock.writes += 1;
      if ('stock_quantity' in body) p.stock_quantity = body.stock_quantity;
      if (body.date_created) p.date_created = body.date_created;
      for (const m of body.meta_data || []) p.meta[m.key] = m.value;
      return { id: p.id };
    },
  };
  return mock;
}
