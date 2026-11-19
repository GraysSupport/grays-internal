// lib/wooCollection.js — G25e2 (owner's back-in-stock rules, 19 Nov 2026, Part 2): the
// collection page's "Apply Stock to Website" button. Plan: feature-plan-stock-sync-2026-11-06.md
// § G25e2 (defaults E-D5–E-D9).
//
// The owner counts a collection in the warehouse and can put it on the website straight away —
// before "Apply Stock and Inventory", which waits for the removalist's cost and never touches the
// website (E-D7). Each SKU gets the back-in-stock treatment (lib/wooStock.js planWebsiteIncrease):
// in stock → + qty only; Sold / ≤ 0 → + qty, Sold off, Add to Cart + Enquire on, publish date now.
// A SKU not on the website becomes a WooCommerce DRAFT (SKU, portal name, stock; no price, images
// or description) for the owner to finish and publish (E-D8).
//
// What was already sent is kept per COLLECTION + SKU in woo_stock_outbox (collection_id, migration
// 0017) — not on collection_items: "Save Collection" deletes and re-inserts every line, which
// would wipe a per-line counter and send the stock twice. Per line, "already on website" is that
// SKU's sent total spread over its lines in order. Rows still waiting, failed, dry-run or handed
// to a human all count as sent (GS handles those by hand), so nothing ever goes twice.
//
// OTHER lines are never listed; the G25 do-not-sync list is listed greyed out (E-D6b, default).
// Same switches as G25: FEATURE_WOO_STOCK_SYNC (off → nothing), WOO_STOCK_SYNC_DRY_RUN (dry →
// "would …", nothing written). Workorder logs are never written for a collection; every call is
// recorded in integration_sync_log.

import {
  isWooStockSyncEnabled, isWooStockDryRun, isSkippedSku, planWebsiteIncrease, buildWooUpdate,
} from './wooStock.js';
import { createWooClient, wooConfigured } from './woocommerce.js';
import { createMockWoo } from './woocommerce.mock.js';

const truthy = (v) => String(v ?? '').trim().toLowerCase() === 'true';
const key = (s) => String(s ?? '').trim().toUpperCase();
const isOther = (sku) => key(sku) === 'OTHER';
const parse = (r) => {
  if (r == null) return null;
  if (typeof r === 'string') { try { return JSON.parse(r); } catch { return null; } }
  return r;
};

// A collection send runs inside the button's request (vercel.json gives the API 60 s); anything
// not reached stays 'pending' for the next press or the daily job.
const DEFAULT_BUDGET_MS = 40000;

/** wp-admin edit link for a website product (the draft note). null without a base URL. */
export function wpAdminLink(productId, env = process.env) {
  const base = String(env?.WOO_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!base || !productId) return null;
  return `${base}/wp-admin/post.php?post=${Number(productId)}&action=edit`;
}

/**
 * The dialog's lines. Pure. `sentBySku`: Map(SKU → quantity already sent for this collection).
 * @returns {Array<{collection_items_id, sku, name, quantity, applied, remaining, state:'ok'|'skip'}>}
 */
export function collectionWebsiteItems(items, sentBySku = new Map(), env = process.env) {
  const left = new Map([...sentBySku].map(([k, v]) => [key(k), Number(v) || 0]));
  const out = [];
  for (const it of [...(items || [])].sort((a, b) => Number(a.collection_items_id) - Number(b.collection_items_id))) {
    if (isOther(it.product_sku)) continue; // E-D6: OTHER is never listed
    const sku = String(it.product_sku);
    const qty = Math.max(0, Number(it.quantity) || 0);
    const base = { collection_items_id: Number(it.collection_items_id), sku, name: it.name ?? null, quantity: qty };
    if (isSkippedSku(sku, env)) { out.push({ ...base, applied: 0, remaining: 0, state: 'skip' }); continue; }
    const pool = left.get(key(sku)) || 0;
    const applied = Math.min(qty, pool);
    left.set(key(sku), pool - applied);
    out.push({ ...base, applied, remaining: qty - applied, state: 'ok' });
  }
  return out;
}

/** What one press sends: ticked lines (itemIds) or all remaining. Pure. */
export function planCollectionSend(list, { all = false, itemIds = [] } = {}) {
  const want = new Set((itemIds || []).map(Number));
  const bySku = {};
  let items = 0;
  let units = 0;
  for (const it of list || []) {
    if (it.state !== 'ok' || it.remaining <= 0) continue;
    if (!all && !want.has(Number(it.collection_items_id))) continue;
    bySku[it.sku] = (bySku[it.sku] || 0) + it.remaining;
    items += 1;
    units += it.remaining;
  }
  return { bySku, items, units };
}

/** Migration 0017 applied (woo_stock_outbox.collection_id)? Any error → no. */
export async function outboxHasCollection(client) {
  try {
    const r = await client.query(
      `SELECT EXISTS (SELECT 1 FROM pg_attribute
                       WHERE attrelid = to_regclass('woo_stock_outbox') AND attname = 'collection_id' AND NOT attisdropped) AS has`
    );
    return Boolean(r.rows?.[0]?.has);
  } catch {
    return false;
  }
}

async function loadCollection(client, id) {
  const r = await client.query(`/* g25e2:collection */ SELECT id, name, status::text AS status, inventory_applied_at FROM collections WHERE id = $1`, [id]);
  return r.rows?.[0] || null;
}

async function loadItems(client, id) {
  const r = await client.query(
    `/* g25e2:items */ SELECT ci.collection_items_id, ci.product_sku, ci.quantity, p.name
       FROM collection_items ci LEFT JOIN product p ON p.sku = ci.product_sku
      WHERE ci.collection_id = $1 ORDER BY ci.collection_items_id`,
    [id]
  );
  return r.rows || [];
}

async function sentBySku(client, id) {
  const r = await client.query(
    `/* g25e2:sent-by-sku */ SELECT sku, SUM(qty) AS qty FROM woo_stock_outbox
      WHERE collection_id = $1 AND status <> 'cancelled' GROUP BY sku`,
    [id]
  );
  return new Map((r.rows || []).map((x) => [key(x.sku), Number(x.qty) || 0]));
}

/** One outbox row → the line's website note. */
function rowNote(row, env) {
  const res = parse(row?.result) || {};
  const err = String(row?.last_error || '').trim();
  const arrow = `${res.before} → ${res.after}`;
  if (row.status === 'sent' && res.action === 'create_draft') return { note: 'Draft created on the website — add photos/price and publish', tone: 'warn', adminUrl: wpAdminLink(res.product_id, env) };
  if (row.status === 'sent') return { note: `On the website: ${arrow}${res.action === 'restock' ? `, back on sale (${res.was_sold ? 'was Sold' : 'was sold out'})` : ''}`, tone: 'ok', adminUrl: null };
  if (row.status === 'dry_run' && res.action === 'create_draft') return { note: `Dry run — would create a draft with stock ${Number(row.qty)} (do it by hand)`, tone: 'muted', adminUrl: null };
  if (row.status === 'dry_run') return { note: `Dry run — would add ${Number(row.qty)} (${arrow}) — do it by hand`, tone: 'muted', adminUrl: null };
  if (row.status === 'needs_human') return { note: `Needs you: ${err || 'check by hand'}`, tone: 'warn', adminUrl: wpAdminLink(res.product_id, env) };
  if (row.status === 'failed') return { note: `Failed: ${err || 'website error'} — press Apply again or wait for the daily retry`, tone: 'warn', adminUrl: null };
  if (row.status === 'sending') return { note: 'Sending…', tone: 'muted', adminUrl: null };
  return { note: 'Waiting to send — press Apply again or wait for the daily retry', tone: 'muted', adminUrl: null };
}

/**
 * GET /api/collections?resource=website&id= — the dialog data. Read-only (no website call).
 */
export async function getCollectionWebsite(client, collectionId, { env = process.env } = {}) {
  const enabled = isWooStockSyncEnabled(env);
  const ready = await outboxHasCollection(client);
  const coll = await loadCollection(client, Number(collectionId));
  if (!coll) return { found: false };
  const base = { found: true, enabled, ready, dryRun: isWooStockDryRun(env), completed: coll.status === 'Completed', status: coll.status };
  if (!ready) return { ...base, available: false, reason: 'Needs database update 0017 first', items: [], notOnWebsite: 0 };
  const sent = await sentBySku(client, coll.id);
  const list = collectionWebsiteItems(await loadItems(client, coll.id), sent, env);
  const rows = (await client.query(`/* g25e2:rows */ SELECT id, sku, qty, status, result, last_error, created_at FROM woo_stock_outbox WHERE collection_id = $1 ORDER BY id`, [coll.id])).rows || [];
  const latest = new Map();
  for (const r of rows) latest.set(key(r.sku), r);
  const items = list.map((it) => {
    const r = it.state === 'ok' ? latest.get(key(it.sku)) : null;
    return r ? { ...it, ...rowNote(r, env), rowStatus: r.status } : { ...it, note: it.state === 'skip' ? 'Not synced (do-not-sync list) — update by hand' : null, tone: 'muted', adminUrl: null, rowStatus: null };
  });
  const notOnWebsite = items.filter((x) => x.state === 'ok' && x.remaining > 0).length;
  const reason = enabled ? null : 'Website stock sync is switched off';
  return { ...base, available: enabled, reason, items, notOnWebsite };
}

function resolveWoo(env) {
  if (truthy(env?.WOO_MOCK)) return createMockWoo([]);
  if (wooConfigured(env)) return createWooClient({ env });
  return null;
}

function isDefiniteRefusal(err) {
  const st = Number(err?.status) || Number((String(err?.message || '').match(/Website returned (\d{3})/) || [])[1]);
  return st >= 400 && st < 500;
}

/**
 * After the commit: send this collection's waiting rows. Best-effort, never throws. Safe to call
 * again (the button and the daily job) — it only picks up pending / failed rows.
 */
export async function syncCollectionWebsiteStock(client, collectionId, { woo, env = process.env, now = new Date(), budgetMs = DEFAULT_BUDGET_MS } = {}) {
  const deadline = Date.now() + budgetMs;
  const summary = { skipped: false, sent: 0, drafts: 0, dryRun: 0, failed: 0, needsHuman: 0, waiting: 0 };
  if (!isWooStockSyncEnabled(env)) return { ...summary, skipped: true };
  const dry = isWooStockDryRun(env);
  const id = Number(collectionId);
  try {
    if (!(await outboxHasCollection(client))) return { ...summary, skipped: true };
    const { rows } = await client.query(
      `/* g25e2:open */ SELECT o.id, o.sku, o.qty, o.attempts, o.result, p.name
         FROM woo_stock_outbox o LEFT JOIN product p ON p.sku = o.sku
        WHERE o.collection_id = $1 AND o.status IN ('pending', 'failed') ORDER BY o.id`,
      [id]
    );
    if (!rows.length) return summary;
    let site = woo;
    let siteError = null;
    if (!site) {
      try { site = resolveWoo(env); } catch (err) { siteError = err?.message; }
      if (!site) siteError = siteError || 'WooCommerce keys are not set up yet';
    }
    const mark = async (row, status, result, error) => {
      await client.query(
        `/* g25e2:mark */ UPDATE woo_stock_outbox SET status = $2::text, result = $3::jsonb, last_error = $4, attempts = attempts + 1,
                sent_at = CASE WHEN $2::text = 'sent' THEN NOW() ELSE sent_at END
          WHERE id = $1`,
        [row.id, status, JSON.stringify(result ?? null), error ?? null]
      );
      try {
        await client.query(
          `INSERT INTO integration_sync_log (source, direction, event_type, reference_id, status, payload, error)
           VALUES ('woocommerce', 'outbound', 'collection_stock', $1, $2, $3::jsonb, $4)
           ON CONFLICT DO NOTHING`,
          [`outbox-${row.id}-a${Number(row.attempts || 0) + 1}`, status, JSON.stringify({ collection_id: id, sku: row.sku, ...(result || {}) }), error ?? null]
        );
      } catch (err) { console.error('collection stock: sync log failed', err?.message); }
    };

    for (const row of rows) {
      if (Date.now() >= deadline) { summary.waiting += 1; continue; }
      const claim = await client.query(
        `/* g25e2:claim */ UPDATE woo_stock_outbox SET status = 'sending' WHERE id = $1 AND status IN ('pending', 'failed') RETURNING id`,
        [row.id]
      );
      if (!claim.rowCount) continue;
      const keep = { by: parse(row.result)?.by ?? null };
      let requested = false;
      try {
        if (!site) throw new Error(siteError);
        const qty = Number(row.qty);
        const website = await site.findProductBySku(row.sku);
        if (!website && !isSkippedSku(row.sku, env)) {
          // E-D8: not on the website → a draft for the owner to finish.
          if (dry) { await mark(row, 'dry_run', { ...keep, action: 'create_draft', after: qty }, null); summary.dryRun += 1; continue; }
          requested = true;
          const made = await site.createDraftProduct({ sku: row.sku, name: row.name || row.sku, stock: qty });
          summary.drafts += 1;
          try { await mark(row, 'sent', { ...keep, action: 'create_draft', product_id: made?.id ?? null, before: null, after: qty }, null); }
          catch (e) { console.error('collection stock: draft made but bookkeeping failed', row.id, e?.message); }
          continue;
        }
        const plan = planWebsiteIncrease({ qty, sku: row.sku, website, env });
        const result = { ...keep, action: plan.action, before: plan.before, after: plan.after, was_sold: !!plan.wasSold, product_id: website?.id ?? null };
        if (plan.action === 'needs_human') { await mark(row, 'needs_human', result, plan.reason); summary.needsHuman += 1; continue; }
        if (dry) { await mark(row, 'dry_run', result, null); summary.dryRun += 1; continue; }
        requested = true;
        await site.updateProduct(website.id, buildWooUpdate(plan, now));
        summary.sent += 1;
        try { await mark(row, 'sent', result, null); }
        catch (e) { console.error('collection stock: sent but bookkeeping failed', row.id, e?.message); }
      } catch (err) {
        const msg = String(err?.message || err);
        if (requested && !isDefiniteRefusal(err)) {
          // The website may or may not have changed (or the draft may exist) — never automatic again.
          try { await mark(row, 'needs_human', keep, `The website didn't confirm the change (${msg}) — check the product on the website by hand`); } catch (e) { console.error('collection stock: mark failed', e?.message); }
          summary.needsHuman += 1;
        } else {
          try { await mark(row, 'failed', keep, msg); } catch (e) { console.error('collection stock: mark failed', e?.message); }
          summary.failed += 1;
        }
      }
    }
  } catch (err) {
    console.error('collection stock sync failed:', err?.message || err);
  }
  return summary;
}

/**
 * POST /api/collections?resource=website-apply&id= — queue what is left (all, or the ticked
 * lines) in one transaction under a collection lock, then send it. The caller checks who.
 * Pressing it again sends nothing twice; it retries rows that failed and lookups a human cleared.
 */
export async function applyCollectionToWebsite(client, collectionId, { all = false, itemIds = [], actorId = '', env = process.env, woo, now = new Date(), budgetMs } = {}) {
  if (!isWooStockSyncEnabled(env)) return { ok: false, status: 409, error: 'Website stock sync is switched off' };
  if (!(await outboxHasCollection(client))) return { ok: false, status: 409, error: 'This needs database update 0017 first' };
  const id = Number(collectionId);
  let queued = 0;
  let plan;
  try {
    await client.query('BEGIN');
    const coll = (await client.query(`/* g25e2:collection */ SELECT id, name, status::text AS status, inventory_applied_at FROM collections WHERE id = $1 FOR UPDATE`, [id])).rows?.[0];
    if (!coll) { await client.query('ROLLBACK'); return { ok: false, status: 404, error: 'Collection not found' }; }
    const list = collectionWebsiteItems(await loadItems(client, id), await sentBySku(client, id), env);
    plan = planCollectionSend(list, { all, itemIds });
    const by = String(actorId || '').trim().toUpperCase().slice(0, 2) || null;
    for (const [sku, qty] of Object.entries(plan.bySku)) {
      await client.query(
        `/* g25e2:insert */ INSERT INTO woo_stock_outbox (collection_id, sku, qty, result, kind, workorder_id)
         VALUES ($1, $2, $3, $4::jsonb, 'increase', NULL)`,
        [id, sku, qty, JSON.stringify({ by })]
      );
      queued += 1;
    }
    // Lookups that were handed to a human sent nothing — pressing Apply again retries them.
    await client.query(
      `/* g25e2:reopen-lookups */ UPDATE woo_stock_outbox SET status = 'failed'
        WHERE collection_id = $1 AND status = 'needs_human' AND result->>'action' = 'needs_human' RETURNING id`,
      [id]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  }
  const summary = await syncCollectionWebsiteStock(client, id, { woo, env, now, ...(budgetMs ? { budgetMs } : {}) });
  return { ok: true, queued, items: plan.items, units: plan.units, summary };
}
