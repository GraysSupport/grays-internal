// scripts/ops-free-weights-smoke.mjs — offline smoke for G21 (owner, 29 Oct 2026): the Brand New
// Free Weights stock, kept per individual weight, with a stock-move audit trail.
//
//   GET  /api/free-weights?resource=list
//   POST /api/free-weights?resource=product          create a line + its weight ladder
//   PUT  /api/free-weights?resource=product&id=      edit a line (never touches stock)
//   POST /api/free-weights?resource=move             receive / sell / adjust one weight
//   GET  /api/free-weights?resource=moves&variant_id=
//
// Exercises lib/freeWeights.js with a fake pg client that behaves like the three tables —
// no network, no database, no secrets.
//
//   node scripts/ops-free-weights-smoke.mjs

process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke_secret';

const jwt = (await import('jsonwebtoken')).default;
const server = await import('../lib/freeWeights.js');
const client = await import('../src/utils/freeWeights.js');
const { handleFreeWeights } = server;

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const token = (id, roles) => `Bearer ${jwt.sign({ id, email: `${id}@x`, roles }, process.env.JWT_SECRET)}`;
const AS = {
  superadmin: token('GS', ['superadmin']),
  admin: token('GA', ['admin']),
  sales: token('BR', ['sales']),
  technician: token('TE', ['technician']),
  techSales: token('TS', ['technician', 'sales']),
  wk: token('WK', ['admin']),
};
const USERS = { GS: 'Nick', GA: 'Vincent', BR: 'Brodie' };

// In-memory free_weight_* tables. `missing: true` = prod before the migration (42P01).
function makeDb({ missing = false } = {}) {
  const db = { products: [], variants: [], moves: [], seq: { p: 0, v: 0, m: 0 }, tx: [], locked: [] };
  const calls = [];
  const undefinedTable = () => Object.assign(new Error('relation "free_weight_products" does not exist'), { code: '42P01' });
  let snapshot = null;
  const clone = () => JSON.parse(JSON.stringify({ products: db.products, variants: db.variants, moves: db.moves, seq: db.seq }));
  const q = {
    db, calls,
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      calls.push({ sql, params });
      if (sql === 'BEGIN') { snapshot = clone(); db.tx.push('BEGIN'); return { rows: [] }; }
      if (sql === 'COMMIT') { snapshot = null; db.tx.push('COMMIT'); return { rows: [] }; }
      if (sql === 'ROLLBACK') { if (snapshot) Object.assign(db, snapshot); snapshot = null; db.tx.push('ROLLBACK'); return { rows: [] }; }
      if (!/free_weight_/.test(sql)) throw new Error(`unexpected SQL in smoke: ${sql}`);
      if (missing) throw undefinedTable();

      if (/^SELECT .* FROM free_weight_products/i.test(sql)) {
        return { rows: db.products.map((p) => ({ ...p })) };
      }
      if (/^SELECT .* FROM free_weight_variants .*FOR UPDATE/i.test(sql)) {
        db.locked.push(params[0]);
        return { rows: db.variants.filter((v) => v.id === Number(params[0])).map((v) => ({ ...v })) };
      }
      if (/^SELECT .* FROM free_weight_variants/i.test(sql)) {
        return { rows: db.variants.map((v) => ({ ...v })) };
      }
      if (/^SELECT .* FROM free_weight_stock_moves/i.test(sql)) {
        const rows = db.moves.filter((m) => m.variant_id === Number(params[0]))
          .slice().reverse().map((m) => ({ ...m, user_name: USERS[m.user_id] || null }));
        return { rows };
      }
      if (/^INSERT INTO free_weight_products/i.test(sql)) {
        const [brand, name, category, notes, userId] = params;
        if (db.products.some((p) => p.brand.toLowerCase() === brand.toLowerCase() && p.name.toLowerCase() === name.toLowerCase())) {
          throw Object.assign(new Error('duplicate key value violates unique constraint "uq_free_weight_products_brand_name"'), { code: '23505' });
        }
        const row = { id: ++db.seq.p, brand, name, category, notes, active: true, created_by: userId, updated_by: userId };
        db.products.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (/^UPDATE free_weight_products/i.test(sql)) {
        const [brand, name, category, notes, active, userId, id] = params;
        const p = db.products.find((x) => x.id === Number(id));
        if (!p) return { rows: [], rowCount: 0 };
        Object.assign(p, { brand, name, category, notes, active, updated_by: userId });
        return { rows: [{ id: p.id }], rowCount: 1 };
      }
      if (/^INSERT INTO free_weight_variants/i.test(sql)) {
        // (product_id, weight_kg, sku, stock, price, unit_cost, reorder_level, active, is_superadmin)
        const [productId, weight, sku, stock, price, unitCost, reorder, active, canCost] = params;
        const existing = db.variants.find((v) => v.product_id === productId && Number(v.weight_kg) === Number(weight));
        if (existing) {
          if (!/ON CONFLICT/i.test(sql)) throw Object.assign(new Error('duplicate weight'), { code: '23505' });
          // The conflict update is guarded: a weight with stock on hand cannot be retired.
          if (/WHERE EXCLUDED\.active OR free_weight_variants\.stock = 0/i.test(sql) && !active && existing.stock > 0) return { rows: [] };
          Object.assign(existing, { sku, price: String(price), reorder_level: reorder, active });
          if (canCost) existing.unit_cost = unitCost == null ? null : String(unitCost);
          return { rows: [{ id: existing.id }] };
        }
        const row = { id: ++db.seq.v, product_id: productId, weight_kg: String(weight), sku, stock, price: String(price), unit_cost: canCost && unitCost != null ? String(unitCost) : null, reorder_level: reorder, active };
        db.variants.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (/^UPDATE free_weight_variants SET stock/i.test(sql)) {
        const [stock, id] = params;
        if (stock < 0) throw Object.assign(new Error('violates check constraint'), { code: '23514' });
        db.variants.find((v) => v.id === Number(id)).stock = stock;
        return { rows: [], rowCount: 1 };
      }
      if (/^INSERT INTO free_weight_stock_moves/i.test(sql)) {
        const [variantId, delta, reason, reference, note, userId] = params;
        db.moves.push({ id: ++db.seq.m, variant_id: variantId, delta, reason, reference, note, user_id: userId, at: new Date('2026-10-30T00:00:00Z').toISOString() });
        return { rows: [] };
      }
      throw new Error(`unexpected SQL in smoke: ${sql}`);
    },
  };
  return q;
}

function makeRes() {
  return {
    statusCode: 200, body: undefined, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function call(dbc, { method = 'GET', as, query = {}, body } = {}) {
  const req = { method, query, body, headers: as ? { authorization: as } : {} };
  const res = makeRes();
  await handleFreeWeights(req, res, dbc);
  return res;
}

const writes = (dbc) => dbc.calls.filter((c) => /^(INSERT|UPDATE|DELETE)/i.test(c.sql));

const TRIGRIP = {
  brand: 'Trigrip', name: 'Olympic Rubber Weight', category: 'plate', notes: '',
  variants: [
    { weight_kg: 1.25, price: 19, unit_cost: 9.5, reorder_level: 4, stock: 10 },
    { weight_kg: 2.5, price: 32, unit_cost: 15, reorder_level: 4, stock: 0 },
    { weight_kg: 20, price: 1795, unit_cost: 900, reorder_level: 2, stock: 3 },
  ],
};

console.log('G21 free weights — access');
{
  const dbc = makeDb();
  let r = await call(dbc, { query: { resource: 'list' } });
  check('no token → 401', r.statusCode === 401);
  r = await call(dbc, { as: AS.technician, query: { resource: 'list' } });
  check('technician (workshop login) → 403', r.statusCode === 403);
  r = await call(dbc, { as: AS.wk, query: { resource: 'list' } });
  check('the WK kiosk (admin by id) → 403', r.statusCode === 403);
  r = await call(dbc, { as: AS.techSales, query: { resource: 'list' } });
  check('technician + sales (office role) → 200', r.statusCode === 200);
  r = await call(dbc, { as: AS.technician, method: 'POST', query: { resource: 'move' }, body: { variant_id: 1, qty: 1, reason: 'received' } });
  check('workshop login cannot move stock', r.statusCode === 403 && writes(dbc).length === 0);
  r = await call(dbc, { as: AS.admin, query: { resource: 'nope' } });
  check('unknown resource → 400', r.statusCode === 400);
  r = await call(dbc, { as: AS.admin, method: 'DELETE', query: { resource: 'list' } });
  check('DELETE is not allowed → 405', r.statusCode === 405);
}

console.log('G21 free weights — create a product line');
const dbc = makeDb();
{
  let r = await call(dbc, { as: AS.admin, method: 'POST', query: { resource: 'product' }, body: TRIGRIP });
  check('admin creates a line → 201', r.statusCode === 201, JSON.stringify(r.body));
  check('runs in one transaction', dbc.db.tx.join(',') === 'BEGIN,COMMIT');
  check('three weights stored', dbc.db.variants.length === 3);
  check('opening stock stored per weight', dbc.db.variants.map((v) => v.stock).join(',') === '10,0,3');
  check('opening stock is a "received" move (zero-stock weights get none)',
    dbc.db.moves.length === 2 && dbc.db.moves.every((m) => m.reason === 'received' && m.note === 'Opening stock' && m.user_id === 'GA'));
  check('admin cannot set unit cost (superadmin only)', dbc.db.variants.every((v) => v.unit_cost === null));

  r = await call(dbc, { as: AS.admin, method: 'POST', query: { resource: 'product' }, body: { ...TRIGRIP, brand: 'TRIGRIP' } });
  check('same brand + name again → 409 and rolled back', r.statusCode === 409 && dbc.db.products.length === 1 && dbc.db.tx.at(-1) === 'ROLLBACK');

  const bad = async (body, label) => {
    const before = writes(dbc).length;
    const res = await call(dbc, { as: AS.admin, method: 'POST', query: { resource: 'product' }, body });
    check(`${label} → 400, nothing written`, res.statusCode === 400 && writes(dbc).length === before, JSON.stringify(res.body));
  };
  await bad({ ...TRIGRIP, name: '  ' }, 'blank name');
  await bad({ ...TRIGRIP, brand: 'X', variants: [] }, 'no weights');
  await bad({ ...TRIGRIP, brand: 'X', variants: [{ weight_kg: 5, price: 1 }, { weight_kg: 5.0, price: 2 }] }, 'duplicate weight');
  await bad({ ...TRIGRIP, brand: 'X', variants: [{ weight_kg: 0, price: 1 }] }, 'zero weight');
  await bad({ ...TRIGRIP, brand: 'X', variants: [{ weight_kg: 1.255, price: 1 }] }, 'weight with 3 decimals');
  await bad({ ...TRIGRIP, brand: 'X', variants: [{ weight_kg: 5, price: -1 }] }, 'negative price');
  await bad({ ...TRIGRIP, brand: 'X', variants: [{ weight_kg: 5, price: 1, stock: 2.5 }] }, 'part-unit opening stock');
  await bad({ ...TRIGRIP, brand: 'X', category: 'treadmill' }, 'unknown category');

  r = await call(dbc, { as: AS.superadmin, method: 'POST', query: { resource: 'product' }, body: { brand: 'Grays', name: 'Hex Dumbbell', category: 'dumbbell', variants: [{ weight_kg: 10, price: 45, unit_cost: 22.5, stock: 0 }] } });
  check('superadmin can set unit cost', r.statusCode === 201 && dbc.db.variants.at(-1).unit_cost === '22.5');
}

console.log('G21 free weights — list');
{
  let r = await call(dbc, { as: AS.sales, query: { resource: 'list' } });
  const line = r.body.products.find((p) => p.name === 'Olympic Rubber Weight');
  check('list → available + lines with their weights', r.statusCode === 200 && r.body.available === true && line.variants.length === 3);
  check('weights sorted lightest first, numbers not strings', line.variants.map((v) => v.weight_kg).join(',') === '1.25,2.5,20');
  check('non-superadmin: no unit_cost, no stock value', !('unit_cost' in line.variants[0]) && r.body.totals.value_at_cost === undefined && r.body.can_see_cost === false);
  check('totals: units on hand', r.body.totals.units === 13);
  r = await call(dbc, { as: AS.superadmin, query: { resource: 'list' } });
  const sline = r.body.products.find((p) => p.name === 'Hex Dumbbell');
  check('superadmin sees unit cost + value at cost', r.body.can_see_cost === true && sline.variants[0].unit_cost === 22.5 && typeof r.body.totals.value_at_cost === 'number');
  check('list is read-only', writes(dbc).length === writes(dbc).length && !dbc.calls.slice(-2).some((c) => /^(INSERT|UPDATE)/i.test(c.sql)));
}

console.log('G21 free weights — stock moves');
{
  const v125 = dbc.db.variants[0]; // 10 on hand
  const v25 = dbc.db.variants[1]; // 0 on hand
  let r = await call(dbc, { as: AS.sales, method: 'POST', query: { resource: 'move' }, body: { variant_id: v125.id, qty: 4, reason: 'sold', reference: 'INV-20411' } });
  check('sold 4 → 200, stock 6', r.statusCode === 200 && r.body.variant.stock === 6 && dbc.db.variants[0].stock === 6);
  check('the move is logged with a negative delta, reference + user', dbc.db.moves.at(-1).delta === -4 && dbc.db.moves.at(-1).reference === 'INV-20411' && dbc.db.moves.at(-1).user_id === 'BR');
  check('row locked FOR UPDATE inside a transaction', dbc.db.locked.includes(v125.id) && dbc.db.tx.slice(-2).join(',') === 'BEGIN,COMMIT');

  r = await call(dbc, { as: AS.admin, method: 'POST', query: { resource: 'move' }, body: { variant_id: v25.id, qty: 1, reason: 'sold' } });
  check('selling from zero → 409, stock unchanged, rolled back', r.statusCode === 409 && dbc.db.variants[1].stock === 0 && /0 on hand/.test(r.body.error) && dbc.db.tx.at(-1) === 'ROLLBACK');

  r = await call(dbc, { as: AS.admin, method: 'POST', query: { resource: 'move' }, body: { variant_id: v25.id, qty: 12, reason: 'received', reference: 'PO-77' } });
  check('received 12 → stock 12', r.statusCode === 200 && dbc.db.variants[1].stock === 12 && dbc.db.moves.at(-1).delta === 12);
  r = await call(dbc, { as: AS.admin, method: 'POST', query: { resource: 'move' }, body: { variant_id: v25.id, qty: -2, reason: 'adjustment', note: 'Stocktake' } });
  check('adjustment takes a signed qty (−2 → 10)', r.statusCode === 200 && dbc.db.variants[1].stock === 10);
  r = await call(dbc, { as: AS.admin, method: 'POST', query: { resource: 'move' }, body: { variant_id: v25.id, qty: 1, reason: 'damaged' } });
  check('damaged takes stock out (→ 9)', r.statusCode === 200 && dbc.db.variants[1].stock === 9);
  r = await call(dbc, { as: AS.admin, method: 'POST', query: { resource: 'move' }, body: { variant_id: v25.id, qty: 1, reason: 'returned' } });
  check('returned puts stock back (→ 10)', r.statusCode === 200 && dbc.db.variants[1].stock === 10);

  const badMove = async (body, label, code = 400) => {
    const before = writes(dbc).length;
    const res = await call(dbc, { as: AS.admin, method: 'POST', query: { resource: 'move' }, body });
    check(`${label} → ${code}, nothing written`, res.statusCode === code && writes(dbc).length === before, JSON.stringify(res.body));
  };
  await badMove({ variant_id: v25.id, qty: 0, reason: 'adjustment' }, 'zero qty');
  await badMove({ variant_id: v25.id, qty: -3, reason: 'received' }, 'negative qty on a receipt');
  await badMove({ variant_id: v25.id, qty: 1.5, reason: 'received' }, 'part unit');
  await badMove({ variant_id: v25.id, qty: 20000, reason: 'received' }, 'over 10,000 at once');
  await badMove({ variant_id: v25.id, qty: 1, reason: 'stolen' }, 'unknown reason');
  await badMove({ variant_id: 999, qty: 1, reason: 'received' }, 'unknown weight', 404);

  r = await call(dbc, { as: AS.sales, query: { resource: 'moves', variant_id: String(v25.id) } });
  check('history: newest first, with names', r.statusCode === 200 && r.body.moves.length === 4 && r.body.moves[0].reason === 'returned' && r.body.moves.at(-1).user_name === 'Vincent');
}

console.log('G21 free weights — edit a line');
{
  const pid = dbc.db.products[0].id;
  const nBefore = dbc.db.variants.length;
  const stockBefore = dbc.db.variants.map((v) => v.stock).join(',');
  let r = await call(dbc, {
    as: AS.admin, method: 'PUT', query: { resource: 'product', id: String(pid) },
    body: { brand: 'Trigrip', name: 'Olympic Rubber Weight', category: 'plate', notes: 'Black', active: true,
      variants: [{ weight_kg: 1.25, price: 21, unit_cost: 1, reorder_level: 6, stock: 999 }, { weight_kg: 5, price: 49 }] },
  });
  check('edit → 200', r.statusCode === 200, JSON.stringify(r.body));
  check('price + reorder level updated', dbc.db.variants[0].price === '21' && dbc.db.variants[0].reorder_level === 6);
  check('stock NEVER changed by an edit (999 ignored)', dbc.db.variants.slice(0, nBefore).map((v) => v.stock).join(',') === stockBefore);
  check('a new weight is added at 0 stock', dbc.db.variants.some((v) => v.product_id === pid && v.weight_kg === '5' && v.stock === 0));
  check('admin edit cannot change unit cost', dbc.db.variants[0].unit_cost === null);
  check('no stock move written by an edit', !dbc.calls.slice(-8).some((c) => /free_weight_stock_moves/.test(c.sql) && /^INSERT/i.test(c.sql)));
  r = await call(dbc, { as: AS.admin, method: 'PUT', query: { resource: 'product', id: '999' }, body: { brand: 'A', name: 'B', category: 'plate', variants: [{ weight_kg: 1, price: 1 }] } });
  check('unknown line → 404', r.statusCode === 404);
}

{
  const upsert = dbc.calls.find((c) => /ON CONFLICT/i.test(c.sql));
  const setClause = upsert.sql.split(/DO UPDATE SET/i)[1]?.split(/\bWHERE\b/i)[0]; // the guard may READ stock
  check('the edit upsert never SETs stock (SQL text)', setClause && !/\bstock\b/i.test(setClause), setClause);
}

console.log('G21 free weights — review fixes');
{
  const pid = dbc.db.products[0].id;
  const line = (variants) => ({ brand: 'Trigrip', name: 'Olympic Rubber Weight', category: 'plate', notes: 'Black', active: true, variants });
  const v25 = dbc.db.variants[1]; // 2.5 kg, 10 on hand
  let r = await call(dbc, { as: AS.admin, method: 'PUT', query: { resource: 'product', id: String(pid) }, body: line([{ weight_kg: 2.5, price: 32, active: false }]) });
  check('retiring a weight that still has stock → 409, rolled back', r.statusCode === 409 && /2\.5 kg/.test(r.body.error) && dbc.db.variants[1].active === true && dbc.db.tx.at(-1) === 'ROLLBACK', JSON.stringify(r.body));
  const v5 = dbc.db.variants.find((v) => v.product_id === pid && v.weight_kg === '5'); // 0 on hand
  r = await call(dbc, { as: AS.admin, method: 'PUT', query: { resource: 'product', id: String(pid) }, body: line([{ weight_kg: 5, price: 49, active: false }]) });
  check('retiring an empty weight is fine', r.statusCode === 200 && v5.active === false);
  check('(2.5 kg untouched)', v25.stock === 10);

  r = await call(dbc, { as: token('IT', ['it-technician']), query: { resource: 'list' } });
  check('legacy it-technician office login can view', r.statusCode === 200);

  const before = writes(dbc).length;
  r = await call(dbc, { as: AS.admin, method: 'POST', query: { resource: 'move' }, body: { variant_id: 2 ** 31, qty: 1, reason: 'received' } });
  check('variant_id beyond int range → 400 (not a 500)', r.statusCode === 400 && writes(dbc).length === before);
  r = await call(dbc, { as: AS.admin, method: 'PUT', query: { resource: 'product', id: String(2 ** 31) }, body: line([{ weight_kg: 1, price: 1 }]) });
  check('product id beyond int range → 400', r.statusCode === 400);
  r = await call(dbc, { as: AS.admin, query: { resource: 'moves', variant_id: String(2 ** 31) } });
  check('history id beyond int range → 400', r.statusCode === 400);
}

console.log('G21 free weights — before the migration (42P01)');
{
  const pre = makeDb({ missing: true });
  let r = await call(pre, { as: AS.admin, query: { resource: 'list' } });
  check('list → 200 available:false', r.statusCode === 200 && r.body.available === false && Array.isArray(r.body.products));
  r = await call(pre, { as: AS.admin, method: 'POST', query: { resource: 'move' }, body: { variant_id: 1, qty: 1, reason: 'received' } });
  check('move → 503 plain message', r.statusCode === 503 && /not set up/i.test(r.body.error));
  r = await call(pre, { as: AS.admin, method: 'POST', query: { resource: 'product' }, body: TRIGRIP });
  check('create → 503', r.statusCode === 503);
}

console.log('G21 free weights — client and server agree');
check('categories match', JSON.stringify(server.FREE_WEIGHT_CATEGORIES) === JSON.stringify(client.FREE_WEIGHT_CATEGORIES.map((c) => c.key)));
check('move reasons match', JSON.stringify(server.MOVE_REASONS) === JSON.stringify(client.MOVE_REASONS.map((r) => r.key)));

console.log(`\n✅ ops-free-weights smoke: ${passed} checks passed`);
