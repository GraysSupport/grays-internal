// lib/freeWeights.js — G21 (owner, 29 Oct 2026): Brand New Free Weights stock.
//
//   GET  /api/free-weights?resource=list                    every line + its weights
//   POST /api/free-weights?resource=product                 create a line + weight ladder
//   PUT  /api/free-weights?resource=product&id=<id>         edit a line (never touches stock)
//   POST /api/free-weights?resource=move                    receive / sell / adjust one weight
//   GET  /api/free-weights?resource=moves&variant_id=<id>   that weight's stock history
//   POST /api/free-weights?resource=category                add a category { label } (30 Oct 2026)
//
// Routed from api/[...path].js (no new serverless function).
//
// A stock list kept completely apart from `product`, lots, workorders and the Woo sync: one row
// per product line, one per individual weight (each with its own count), and an append-only
// move log. Stock changes ONLY through a move — locked FOR UPDATE, never below zero, written in
// the same transaction as the move row — so every unit on hand has a who / why / when.
//
// Access (server-authoritative, login token required): every office login — the same people
// who can open Products today. Workshop logins (technician / workshop without an office role,
// and the WK kiosk by id) get 403, as the Products nav already hides it from them. Unit cost
// and stock value at cost are superadmin-only, like the Products cost column.
//
// The tables arrive with migration 0011, applied to the Neon DEV branch only until the owner
// migrates prod at merge time — so a missing table (42P01) is an expected state: the list says
// `available: false` and writes get a plain 503.

import { requireRoles, hasAnyRole, ROLES } from './rbac.js';
import { isWorkshopRestricted } from './workshopAccess.js';

// Mirrors FREE_WEIGHT_CATEGORIES / MOVE_REASONS in src/utils/freeWeights.js —
// scripts/ops-free-weights-smoke.mjs pins the two equal.
export const FREE_WEIGHT_CATEGORIES = ['plate', 'bumper', 'dumbbell', 'kettlebell', 'bar', 'collar', 'other'];
export const MOVE_REASONS = ['received', 'sold', 'adjustment', 'damaged', 'returned'];
const REASON_SIGN = { received: 1, returned: 1, sold: -1, damaged: -1, adjustment: 0 };
export const MAX_MOVE_QTY = 10000;
const MAX_TEXT = { brand: 80, name: 120, notes: 1000, sku: 60, reference: 200, note: 500 };
const MOVES_LIMIT = 200;

// Categories (owner revision, 30 Oct 2026): the built-ins above are seeded by migration 0011;
// staff can add more. A line's category must be a row here.
const CATEGORIES_SELECT = `
  SELECT key, label, sort, builtin FROM free_weight_categories ORDER BY sort, lower(label)
`;
const CATEGORY_EXISTS = `SELECT key FROM free_weight_categories WHERE key = $1`;
const CATEGORY_INSERT = `
  INSERT INTO free_weight_categories (key, label, created_by) VALUES ($1, $2, $3)
  RETURNING key, label
`;
const CATEGORY_LABEL_MAX = 40;
const BUILTIN_LABELS = { plate: 'Plates', bumper: 'Bumper plates', dumbbell: 'Dumbbells', kettlebell: 'Kettlebells', bar: 'Bars', collar: 'Collars', other: 'Other' };

const PRODUCTS_SELECT = `
  SELECT id, brand, name, category, notes, active, updated_at
    FROM free_weight_products
   ORDER BY lower(brand), lower(name)
`;
const VARIANTS_SELECT = `
  SELECT id, product_id, weight_kg, sku, stock, price, unit_cost, reorder_level, active
    FROM free_weight_variants
   ORDER BY product_id, weight_kg
`;
const PRODUCT_INSERT = `
  INSERT INTO free_weight_products (brand, name, category, notes, created_by, updated_by)
  VALUES ($1, $2, $3, $4, $5, $5)
  RETURNING id
`;
const PRODUCT_UPDATE = `
  UPDATE free_weight_products
     SET brand = $1, name = $2, category = $3, notes = $4, active = $5, updated_by = $6, updated_at = now()
   WHERE id = $7
  RETURNING id
`;
// $9 = may the caller set unit cost (superadmin). Create: a plain insert (weights are
// validated unique first). Edit: upsert by weight — price / reorder / SKU / active change,
// unit cost only for superadmin, and STOCK IS NEVER IN THE UPDATE SET. A weight that still has
// stock on hand cannot be retired (no row back) — its units would vanish from the totals.
const VARIANT_INSERT = `
  INSERT INTO free_weight_variants (product_id, weight_kg, sku, stock, price, unit_cost, reorder_level, active)
  VALUES ($1, $2, $3, $4, $5, CASE WHEN $9::boolean THEN $6::numeric ELSE NULL END, $7, $8)
  RETURNING id
`;
const VARIANT_UPSERT = `
  INSERT INTO free_weight_variants (product_id, weight_kg, sku, stock, price, unit_cost, reorder_level, active)
  VALUES ($1, $2, $3, $4, $5, CASE WHEN $9::boolean THEN $6::numeric ELSE NULL END, $7, $8)
  ON CONFLICT (product_id, weight_kg) DO UPDATE
     SET sku = EXCLUDED.sku,
         price = EXCLUDED.price,
         unit_cost = CASE WHEN $9::boolean THEN EXCLUDED.unit_cost ELSE free_weight_variants.unit_cost END,
         reorder_level = EXCLUDED.reorder_level,
         active = EXCLUDED.active,
         updated_at = now()
   WHERE EXCLUDED.active OR free_weight_variants.stock = 0
  RETURNING id
`;
const VARIANT_LOCK = `
  SELECT id, product_id, weight_kg, stock FROM free_weight_variants WHERE id = $1 FOR UPDATE
`;
const VARIANT_SET_STOCK = `
  UPDATE free_weight_variants SET stock = $1, updated_at = now() WHERE id = $2
`;
const MOVE_INSERT = `
  INSERT INTO free_weight_stock_moves (variant_id, delta, reason, reference, note, user_id)
  VALUES ($1, $2, $3, $4, $5, $6)
`;
const MOVES_SELECT = `
  SELECT m.id, m.variant_id, m.delta, m.reason, m.reference, m.note, m.user_id, m.at, u.name AS user_name
    FROM free_weight_stock_moves m
    LEFT JOIN users u ON u.id = m.user_id
   WHERE m.variant_id = $1
   ORDER BY m.at DESC, m.id DESC
   LIMIT ${MOVES_LIMIT}
`;

class BadRequest extends Error {}
class Conflict extends Error {}
const bad = (msg) => { throw new BadRequest(msg); };
// A Postgres `integer` id: anything bigger would fail in the database (22003) as a 500.
const MAX_INT = 2147483647;
const isId = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_INT;
// `it-technician` is a legacy users.access value (not in ROLES) for an office IT login.
const OFFICE_AND_WORKSHOP_ROLES = [...ROLES, 'it-technician'];

const num = (v) => (v == null ? null : Number(v));
/** Text input: NUL dropped (Postgres text can't hold it), trimmed, length-capped. */
function cleanText(v, field, { required = false } = {}) {
  if (v == null || v === '') {
    if (required) bad(`${field[0].toUpperCase()}${field.slice(1)} is required`);
    return null;
  }
  if (typeof v !== 'string') bad(`${field} must be text`);
  const s = v.replace(/\u0000/g, '').trim();
  if (!s && required) bad(`${field[0].toUpperCase()}${field.slice(1)} is required`);
  if (s.length > MAX_TEXT[field]) bad(`${field} is limited to ${MAX_TEXT[field]} characters`);
  return s || null;
}
const twoDecimals = (n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-9;
function money(v, label, { nullable = false } = {}) {
  if (v == null || v === '') {
    if (nullable) return null;
    bad(`${label} is required`);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 99999999 || !twoDecimals(n)) bad(`${label} must be a dollar amount (up to 2 decimals)`);
  return n;
}
function wholeNumber(v, label, { min = 0, max = MAX_MOVE_QTY, nullable = false } = {}) {
  if (v == null || v === '') {
    if (nullable) return null;
    bad(`${label} is required`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) bad(`${label} must be a whole number from ${min} to ${max.toLocaleString('en-AU')}`);
  return n;
}

/** Validate a line + its weights. `withStock`: create (opening stock allowed). */
function parseProduct(body, { withStock }) {
  if (!body || typeof body !== 'object') bad('Product details are required');
  const brand = cleanText(body.brand, 'brand', { required: true });
  const name = cleanText(body.name, 'name', { required: true });
  // Shape only here; that the category exists is checked against the table (assertCategory).
  const category = body.category == null || body.category === '' ? 'other' : String(body.category);
  if (!/^[a-z0-9-]{1,40}$/.test(category)) bad('Unknown category');
  const notes = cleanText(body.notes, 'notes');
  const active = body.active === undefined ? true : body.active === true;
  if (!Array.isArray(body.variants) || body.variants.length === 0) bad('Add at least one weight');
  if (body.variants.length > 100) bad('A line can have at most 100 weights');
  const seen = new Set();
  const variants = body.variants.map((v, i) => {
    const w = Number(v?.weight_kg);
    if (!Number.isFinite(w) || w < 0.25 || w > 500 || !twoDecimals(w)) bad(`Weight ${i + 1} must be 0.25–500 kg (up to 2 decimals)`);
    const key = w.toFixed(2);
    if (seen.has(key)) bad(`${w} kg is listed twice`);
    seen.add(key);
    return {
      weight_kg: w,
      sku: cleanText(v.sku, 'sku'),
      price: money(v.price, `Price for ${w} kg`),
      unit_cost: money(v.unit_cost, `Cost for ${w} kg`, { nullable: true }),
      reorder_level: wholeNumber(v.reorder_level, `Reorder level for ${w} kg`, { nullable: true }),
      active: v.active === undefined ? true : v.active === true,
      stock: withStock ? wholeNumber(v.stock ?? 0, `Opening stock for ${w} kg`) : 0,
    };
  });
  return { brand, name, category, notes, active, variants };
}

/** Rows → the list response. Cost fields only when `canSeeCost`. */
function shapeList(products, variants, canSeeCost) {
  const byProduct = new Map();
  for (const v of variants) {
    const out = {
      id: v.id, weight_kg: num(v.weight_kg), sku: v.sku || null, stock: Number(v.stock) || 0,
      price: num(v.price), reorder_level: v.reorder_level == null ? null : Number(v.reorder_level), active: v.active !== false,
    };
    if (canSeeCost) out.unit_cost = num(v.unit_cost);
    if (!byProduct.has(v.product_id)) byProduct.set(v.product_id, []);
    byProduct.get(v.product_id).push(out);
  }
  const list = products.map((p) => ({
    id: p.id, brand: p.brand, name: p.name, category: p.category, notes: p.notes || '', active: p.active !== false,
    variants: (byProduct.get(p.id) || []).sort((a, b) => a.weight_kg - b.weight_kg),
  }));
  const totals = { units: 0 };
  let value = 0;
  let costMissing = 0;
  for (const p of list) {
    for (const v of p.variants) {
      if (!v.active || !p.active) continue;
      totals.units += v.stock;
      if (canSeeCost && v.stock > 0) {
        if (v.unit_cost == null) costMissing += v.stock;
        else value += v.stock * v.unit_cost;
      }
    }
  }
  if (canSeeCost) {
    totals.value_at_cost = Math.round(value * 100) / 100;
    totals.units_without_cost = costMissing;
  }
  return { available: true, can_see_cost: canSeeCost, products: list, totals };
}

const shapeCategories = (rows) => rows.map((c) => ({ key: c.key, label: c.label, builtin: c.builtin === true }));
const builtinCategories = () => FREE_WEIGHT_CATEGORIES.map((key) => ({ key, label: BUILTIN_LABELS[key], builtin: true }));

async function readList(client, canSeeCost) {
  const p = await client.query(PRODUCTS_SELECT);
  const v = await client.query(VARIANTS_SELECT);
  let categories;
  try {
    categories = shapeCategories((await client.query(CATEGORIES_SELECT)).rows);
  } catch (err) {
    if (err?.code !== '42P01') throw err; // a half-migrated database must not hide the stock
    categories = builtinCategories();
  }
  return { ...shapeList(p.rows, v.rows, canSeeCost), categories };
}

async function assertCategory(client, key) {
  const r = await client.query(CATEGORY_EXISTS, [key]);
  if (!r.rows.length) bad('Unknown category — add it first');
}

/** "Medicine balls!" → "medicine-balls" (a stable key; the label is what people see). */
function categoryKey(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
}

async function createCategory(client, auth, body) {
  const raw = body?.label;
  if (typeof raw !== 'string') bad('Category name is required');
  const label = raw.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  if (label.length < 2 || label.length > CATEGORY_LABEL_MAX) bad(`Category names are 2 to ${CATEGORY_LABEL_MAX} characters`);
  const base = categoryKey(label);
  if (!base) bad('Category names need a letter or number');
  const existing = (await client.query(CATEGORIES_SELECT)).rows;
  if (existing.some((c) => c.label.toLowerCase() === label.toLowerCase())) throw new Conflict(`The category "${label}" already exists`);
  const keys = new Set(existing.map((c) => c.key));
  let suffix = 1;
  const nextKey = () => {
    let key = suffix === 1 ? base : `${base}-${suffix}`;
    while (keys.has(key)) { suffix += 1; key = `${base}-${suffix}`; }
    return key;
  };
  // Someone may add the same KEY between our read and our insert: try the next suffix (a few
  // times). The same NAME added at the same moment hits the label index → 409 below.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const key = nextKey();
    try {
      return (await client.query(CATEGORY_INSERT, [key, label, auth.id])).rows[0];
    } catch (err) {
      const keyTaken = err?.code === '23505' && (err.constraint === 'free_weight_categories_pkey' || String(err.message || '').includes('free_weight_categories_pkey'));
      if (!keyTaken) throw err;
      keys.add(key);
    }
  }
  throw new Conflict('Could not add the category right now — please try again');
}

async function inTransaction(client, work) {
  await client.query('BEGIN');
  try {
    const out = await work();
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function createProduct(client, auth, canSeeCost, body) {
  const p = parseProduct(body, { withStock: true });
  return inTransaction(client, async () => {
    await assertCategory(client, p.category);
    const r = await client.query(PRODUCT_INSERT, [p.brand, p.name, p.category, p.notes, auth.id]);
    const productId = r.rows[0].id;
    for (const v of p.variants) {
      const vr = await client.query(VARIANT_INSERT, [productId, v.weight_kg, v.sku, v.stock, v.price, v.unit_cost, v.reorder_level, v.active, canSeeCost]);
      if (v.stock > 0) {
        await client.query(MOVE_INSERT, [vr.rows[0].id, v.stock, 'received', null, 'Opening stock', auth.id]);
      }
    }
    return productId;
  });
}

async function updateProduct(client, auth, canSeeCost, id, body) {
  const p = parseProduct(body, { withStock: false });
  return inTransaction(client, async () => {
    await assertCategory(client, p.category);
    const r = await client.query(PRODUCT_UPDATE, [p.brand, p.name, p.category, p.notes, p.active, auth.id, id]);
    if (!r.rows.length) return null;
    for (const v of p.variants) {
      const u = await client.query(VARIANT_UPSERT, [id, v.weight_kg, v.sku, 0, v.price, v.unit_cost, v.reorder_level, v.active, canSeeCost]);
      if (!u.rows.length) throw new Conflict(`${v.weight_kg} kg still has stock on hand — move it out before marking it not stocked`);
    }
    return id;
  });
}

/** Parse a move; returns the signed delta. Receipts/returns add, sales/damage remove,
 *  adjustments take a signed quantity. */
function parseMove(body) {
  if (!body || typeof body !== 'object') bad('Move details are required');
  const variantId = Number(body.variant_id);
  if (!isId(variantId)) bad('variant_id is required');
  const reason = String(body.reason || '');
  if (!MOVE_REASONS.includes(reason)) bad('Unknown reason');
  const sign = REASON_SIGN[reason];
  const qty = Number(body.qty);
  if (!Number.isInteger(qty) || qty === 0 || Math.abs(qty) > MAX_MOVE_QTY) {
    bad(`Quantity must be a whole number from 1 to ${MAX_MOVE_QTY.toLocaleString('en-AU')}`);
  }
  if (sign !== 0 && qty < 0) bad('Quantity must be positive for this reason');
  const delta = sign === 0 ? qty : sign * qty;
  return {
    variantId, reason, delta,
    reference: cleanText(body.reference, 'reference'),
    note: cleanText(body.note, 'note'),
  };
}

async function recordMove(client, auth, body) {
  const m = parseMove(body);
  return inTransaction(client, async () => {
    const r = await client.query(VARIANT_LOCK, [m.variantId]);
    if (!r.rows.length) return null;
    const onHand = Number(r.rows[0].stock) || 0;
    const next = onHand + m.delta;
    if (next < 0) throw new Conflict(`Only ${onHand} on hand — cannot take out ${-m.delta}`);
    await client.query(VARIANT_SET_STOCK, [next, m.variantId]);
    await client.query(MOVE_INSERT, [m.variantId, m.delta, m.reason, m.reference, m.note, auth.id]);
    return { id: m.variantId, stock: next };
  });
}

export async function handleFreeWeights(req, res, client) {
  const { method } = req;
  if (method !== 'GET' && method !== 'POST' && method !== 'PUT') {
    res.setHeader('Allow', ['GET', 'POST', 'PUT']);
    return res.status(405).json({ error: 'Method not allowed for free weights' });
  }

  const gate = requireRoles(req, OFFICE_AND_WORKSHOP_ROLES);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
  if (isWorkshopRestricted(gate.auth)) {
    return res.status(403).json({ error: 'Free weights stock is not available to workshop logins' });
  }
  const canSeeCost = hasAnyRole(gate.auth.roles, ['superadmin']);
  const resource = String(req.query?.resource || '');
  const route = `${method} ${resource}`;

  try {
    if (route === 'GET list') {
      try {
        return res.status(200).json(await readList(client, canSeeCost));
      } catch (err) {
        if (err?.code !== '42P01') throw err;
        return res.status(200).json({ available: false, can_see_cost: canSeeCost, products: [], totals: { units: 0 }, categories: builtinCategories() });
      }
    }

    if (route === 'GET moves') {
      const variantId = Number(req.query?.variant_id);
      if (!isId(variantId)) return res.status(400).json({ error: 'variant_id is required' });
      const r = await client.query(MOVES_SELECT, [variantId]);
      return res.status(200).json({
        moves: r.rows.map((m) => ({
          id: m.id, delta: Number(m.delta), reason: m.reason, reference: m.reference || null, note: m.note || null,
          user_id: m.user_id || null, user_name: m.user_name || null, at: m.at,
        })),
      });
    }

    if (route === 'POST product') {
      const id = await createProduct(client, gate.auth, canSeeCost, req.body);
      return res.status(201).json({ id, ...(await readList(client, canSeeCost)) });
    }

    if (route === 'PUT product') {
      const id = Number(req.query?.id);
      if (!isId(id)) return res.status(400).json({ error: 'Product id is required' });
      const done = await updateProduct(client, gate.auth, canSeeCost, id, req.body);
      if (!done) return res.status(404).json({ error: 'Product line not found' });
      return res.status(200).json({ id, ...(await readList(client, canSeeCost)) });
    }

    if (route === 'POST category') {
      const category = await createCategory(client, gate.auth, req.body);
      const categories = shapeCategories((await client.query(CATEGORIES_SELECT)).rows);
      return res.status(201).json({ category, categories });
    }

    if (route === 'POST move') {
      const variant = await recordMove(client, gate.auth, req.body);
      if (!variant) return res.status(404).json({ error: 'Weight not found' });
      return res.status(200).json({ variant });
    }

    return res.status(400).json({ error: 'Unknown free weights request' });
  } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    if (err instanceof Conflict) return res.status(409).json({ error: err.message });
    if (err?.code === '23505') {
      const hit = (name) => String(err.constraint || '').includes(name) || String(err.message || '').includes(name);
      if (hit('free_weight_categories')) return res.status(409).json({ error: 'That category already exists' });
      const sameLine = hit('uq_free_weight_products_brand_name');
      return res.status(409).json({ error: sameLine ? 'That brand and product name already exists' : 'That weight is already listed for this product' });
    }
    if (err?.code === '42P01') return res.status(503).json({ error: 'Free weights stock is not set up on this database yet' });
    throw err;
  }
}
