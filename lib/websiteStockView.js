// lib/websiteStockView.js — G25c (owner chose "G25 follow-ups", 18 Nov 2026; plan
// feature-plan-stock-sync-2026-11-06.md § UI + "Weekly drift report").
//
//   GET /api/website-stock?resource=column  → website stock for every portal SKU (Products page)
//   GET /api/website-stock?resource=drift   → live drift check, mismatches only (superadmin)
//   GET /api/website-stock?resource=report  → the latest weekly drift report (superadmin)
//   GET /api/website-stock-drift            → CRON_SECRET-checked weekly job (one-segment path;
//                                             the daily job also runs it on Mondays)
//
// STRICTLY READ-ONLY toward the website: the only WooCommerce call used here is
// findProductsBySkus() — one GET per ≤100 SKUs. Nothing in this file can change website stock,
// and there is deliberately no "Set website to portal" button in this increment.
//
// Who sees it: the column = the same people as the website-stock activity lines
// (canSeeWebsiteStockLog: superadmin incl. GS, plus GM); workshop logins never (G17).
// The drift report = superadmin only.

import { createWooClient, wooConfigured } from './woocommerce.js';
import { canSeeWebsiteStockLog, isSkippedSku } from './wooStock.js';
import { isWorkshopRestricted } from './workshopAccess.js';
import { getAuthUser } from './rbac.js';
import { cronGate } from './cronAuth.js';

export const WOO_SKU_BATCH = 100;     // WooCommerce REST per_page maximum
const CONCURRENCY = 3;                // batches in flight at once (≈1,000 SKUs → 10 GETs)
const EVENT = 'stock_drift_report';

const truthy = (v) => String(v ?? '').trim().toLowerCase() === 'true';
const key = (s) => String(s ?? '').trim().toUpperCase();

/** Unique, sendable SKUs in batches of ≤100. A comma would split WooCommerce's sku filter. */
export function chunkSkus(skus, size = WOO_SKU_BATCH) {
  const seen = new Set();
  const list = [];
  for (const raw of skus || []) {
    const s = String(raw ?? '').trim();
    if (!s || s.includes(',') || seen.has(s.toUpperCase())) continue;
    seen.add(s.toUpperCase());
    list.push(s);
  }
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Read website stock for the given SKUs, ≤100 per GET, a few batches at a time.
 * Never throws: a failed batch is reported and its SKUs become "unknown" (not "not on website").
 * @returns {{ map: Map<string,{stock:number|null, manageStock:boolean, id:number}>, unknown: Set<string>, errors: string[] }}
 */
export async function fetchWebsiteStock(woo, skus) {
  const map = new Map();
  const unknown = new Set();
  const errors = [];
  const batches = chunkSkus(skus);
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    await Promise.all(batches.slice(i, i + CONCURRENCY).map(async (batch) => {
      try {
        const rows = await woo.findProductsBySkus(batch);
        for (const p of rows || []) {
          const k = key(p?.sku);
          if (!k || map.has(k)) continue;
          const n = p.stock_quantity == null ? null : Number(p.stock_quantity);
          map.set(k, { stock: Number.isFinite(n) ? n : null, manageStock: p.manage_stock !== false, id: p.id });
        }
      } catch (err) {
        errors.push(String(err?.message || err));
        for (const s of batch) unknown.add(key(s));
      }
    }));
  }
  return { map, unknown, errors };
}

/**
 * Portal products vs website. state:
 *   match | mismatch | not_on_website | not_tracked (website doesn't manage stock) |
 *   skipped (never synced: supplier, per-kg, consignment, packages, non-products) | unknown (read failed)
 */
export function compareWithWebsite(products, site, env = process.env) {
  return (products || []).map((p) => {
    const k = key(p.sku);
    const portal = Number(p.stock) || 0;
    const w = site?.map?.get(k);
    const base = { sku: p.sku, name: p.name ?? null, brand: p.brand ?? null, portal, website: w ? w.stock : null };
    let state;
    if (site?.unknown?.has(k)) state = 'unknown';
    else if (isSkippedSku(p.sku, env)) state = 'skipped';
    else if (!w) state = 'not_on_website';
    else if (!w.manageStock || w.stock == null) state = 'not_tracked';
    else state = w.stock === portal ? 'match' : 'mismatch';
    return { ...base, state };
  });
}

/** Drift = stock disagrees, or portal has stock the website doesn't list. Nothing else. */
export function driftRows(rows) {
  return (rows || []).filter((r) => r.state === 'mismatch' || (r.state === 'not_on_website' && r.portal > 0));
}

function counts(rows, drift) {
  return {
    checked: rows.length,
    mismatches: drift.filter((r) => r.state === 'mismatch').length,
    notOnWebsite: drift.filter((r) => r.state === 'not_on_website').length,
    unknown: rows.filter((r) => r.state === 'unknown').length,
  };
}

/**
 * Preview without WooCommerce keys (WOO_MOCK=true): plausible sample website data so the column
 * and the report can be reviewed. Deterministic. Labelled "sample" on screen.
 */
export function mockWebsiteFromPortal(products) {
  const out = [];
  [...(products || [])].sort((a, b) => String(a.sku).localeCompare(String(b.sku))).forEach((p, i) => {
    if (i % 11 === 10) return; // "not on website"
    const stock = Number(p.stock) || 0;
    out.push({ id: 900000 + i, sku: p.sku, stock_quantity: i % 7 === 3 ? stock + 1 : stock, manage_stock: true, status: 'publish' });
  });
  return out;
}

function resolveWoo(env, woo) {
  if (woo) return { source: 'live', woo };
  if (truthy(env?.WOO_MOCK)) return { source: 'mock', woo: null };
  if (wooConfigured(env)) return { source: 'live', woo: createWooClient({ env }) };
  return { source: 'none', woo: null };
}

async function loadProducts(client) {
  const { rows } = await client.query('SELECT sku, name, brand, stock FROM product ORDER BY sku');
  return rows;
}

/** Portal products + website read + comparison. `null` when the website isn't set up. */
export async function buildComparison(client, { env = process.env, woo } = {}) {
  const src = resolveWoo(env, woo);
  if (src.source === 'none') return null;
  const products = await loadProducts(client);
  let site;
  if (src.source === 'mock') {
    const map = new Map(mockWebsiteFromPortal(products).map((p) => [key(p.sku), { stock: p.stock_quantity, manageStock: true, id: p.id }]));
    site = { map, unknown: new Set(), errors: [] };
  } else {
    site = await fetchWebsiteStock(src.woo, products.map((p) => p.sku));
  }
  return { source: src.source, rows: compareWithWebsite(products, site, env), errors: site.errors, checkedAt: new Date().toISOString() };
}

/** Monday in Melbourne (the daily job runs at 07:00 / 06:00 Melbourne). */
export function isDriftDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short' }).format(now) === 'Mon';
}

async function logTableReady(client) {
  const r = await client.query(`SELECT to_regclass('public.integration_sync_log') AS t`);
  return Boolean(r.rows?.[0]?.t);
}

/** The weekly job: compare, store mismatches only in integration_sync_log. Never throws. */
export async function runWeeklyDriftReport(client, { env = process.env, woo } = {}) {
  try {
    if (resolveWoo(env, woo).source === 'none') return { skipped: true, reason: 'website not set up' };
    if (!(await logTableReady(client))) return { skipped: true, reason: 'integration_sync_log missing' };
    const cmp = await buildComparison(client, { env, woo });
    const drift = driftRows(cmp.rows);
    const c = counts(cmp.rows, drift);
    const payload = { checkedAt: cmp.checkedAt, source: cmp.source, counts: c, rows: drift, errors: cmp.errors };
    const status = cmp.errors.length ? 'partial' : 'ok';
    await client.query(
      `INSERT INTO integration_sync_log (source, direction, event_type, status, payload, error) VALUES ('woocommerce', 'inbound', $1, $2, $3::jsonb, $4)`,
      [EVENT, status, JSON.stringify(payload), cmp.errors.length ? cmp.errors.slice(0, 3).join(' | ') : null]
    );
    return { ok: true, status, ...c };
  } catch (err) {
    console.error('website drift report failed:', err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
}

async function latestReport(client) {
  if (!(await logTableReady(client))) return null;
  const { rows } = await client.query(
    `SELECT created_at, status, payload, error FROM integration_sync_log WHERE source = 'woocommerce' AND event_type = $1 ORDER BY id DESC LIMIT 1`,
    [EVENT]
  );
  if (!rows.length) return null;
  const r = rows[0];
  const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
  return { createdAt: r.created_at, status: r.status, error: r.error, ...payload };
}

const isSuperadmin = (auth) => (auth?.roles || []).some((r) => String(r).toLowerCase() === 'superadmin');

/** GET /api/website-stock?resource=column|drift|report — read-only. */
export async function handleWebsiteStock(req, res, { getClient, env = process.env, woo } = {}) {
  if (String(req.method || '').toUpperCase() !== 'GET') { res.setHeader('Allow', ['GET']); return res.status(405).json({ error: 'Method Not Allowed' }); }
  const auth = getAuthUser(req);
  if (!auth || !auth.id) return res.status(401).json({ error: 'Please sign in again' });
  if (isWorkshopRestricted(auth) || !canSeeWebsiteStockLog(auth, env)) return res.status(403).json({ error: 'Website stock is not available to this login' });
  const resource = String(req.query?.resource || 'column');
  if (!['column', 'drift', 'report'].includes(resource)) return res.status(400).json({ error: 'Unknown resource' });
  if (resource !== 'column' && !isSuperadmin(auth)) return res.status(403).json({ error: 'The drift report is for superadmins' });

  const client = await getClient();
  try {
    if (resource === 'report') return res.status(200).json({ report: await latestReport(client) });
    const cmp = await buildComparison(client, { env, woo });
    if (!cmp) return res.status(200).json({ available: false, reason: 'The website connection is not set up here' });
    if (resource === 'column') {
      const items = {};
      for (const r of cmp.rows) items[r.sku] = { website: r.website, state: r.state };
      return res.status(200).json({ available: true, source: cmp.source, checkedAt: cmp.checkedAt, errors: cmp.errors, items });
    }
    const drift = driftRows(cmp.rows);
    return res.status(200).json({ available: true, source: cmp.source, checkedAt: cmp.checkedAt, errors: cmp.errors, counts: counts(cmp.rows, drift), rows: drift });
  } finally {
    client.release();
  }
}

/** GET /api/website-stock-drift — the weekly job on its own path (CRON_SECRET-checked). */
export async function handleWebsiteStockDrift(req, res, { getClient, env = process.env, report = runWeeklyDriftReport } = {}) {
  const gate = cronGate(req, env);
  if (!gate.ok) {
    if (gate.allow) res.setHeader('Allow', gate.allow);
    return res.status(gate.status).json({ error: gate.error });
  }
  const client = await getClient();
  try {
    const result = await report(client, { env });
    console.log('website drift report:', JSON.stringify(result));
    return res.status(200).json({ ok: true, ...result });
  } finally {
    client.release();
  }
}
