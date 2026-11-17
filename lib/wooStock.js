// lib/wooStock.js — G25: a workorder is created (or items added) → the website stock follows.
//
// Owner workflow (marketing lead, 17 Nov 2026; feature-plan-stock-sync-2026-11-06.md §G25):
// today GS reduces WooCommerce stock by hand for every non-website sale and then ticks the
// workorder's E-Commerce flag. This module does that job:
//
//   salesperson | website after the sale | sent to WooCommerce
//   not WB      | ≥ 1                    | stock_quantity = website − qty
//   not WB      | 0                      | stock 0 + sold-out treatment
//   WB          | ≥ 1                    | nothing (checkout already took it)
//   WB          | 0                      | sold-out treatment only
//
// Sold-out treatment (D4, confirmed 17 Nov 2026): publish date = now − 1 year,
// add_to_cart_button = 0, enquire_button = 0, sold = 1.
//
// It always SUBTRACTS this sale from what the website shows now — never copies the portal
// total — so an unkeyed web sale can never be added back.
//
// Flow: queueWooStock() writes outbox rows INSIDE the workorder transaction (a website outage
// never loses a sale); syncWorkorderWebsiteStock() runs AFTER the commit, is best-effort and
// NEVER throws. When every row is sent, the E-Commerce flag is ticked for GS automatically.
//
// Switches (all default to the safe side):
//   FEATURE_WOO_STOCK_SYNC=true   — otherwise nothing is queued or sent (portal unchanged)
//   WOO_STOCK_SYNC_DRY_RUN=false  — otherwise "would set …" is logged and nothing is written
//   WOO_SKIP_SALESPERSON=WB       — salespeople whose orders came through website checkout
//   WOO_SKIP_SKUS=A,B             — extra SKUs never synced (added to the built-in list)
//   WOO_MOCK=true                 — use the in-memory WooCommerce (Preview without keys)

import { createWooClient, wooConfigured } from './woocommerce.js';
import { createMockWoo } from './woocommerce.mock.js';

const truthy = (v) => String(v ?? '').trim().toLowerCase() === 'true';

export function isWooStockSyncEnabled(env = process.env) {
  return truthy(env?.FEATURE_WOO_STOCK_SYNC);
}

/** Dry run unless explicitly turned off — the first week in Production runs dry. */
export function isWooStockDryRun(env = process.env) {
  return String(env?.WOO_STOCK_SYNC_DRY_RUN ?? '').trim().toLowerCase() !== 'false';
}

/**
 * Who may see the website-stock lines in a workorder's activity (owner, 17 Nov 2026: "just
 * superadmin or GS … other people don't need to know except for me"). GS is a superadmin; the
 * marketing lead's login (GM) is added by default. More IDs: WOO_STOCK_LOG_VIEWERS=AB,CD.
 * `auth` must come from the signed login token (rbac getAuthUser), never a client header.
 */
export function canSeeWebsiteStockLog(auth, env = process.env) {
  if (!auth) return false;
  if ((auth.roles || []).some((r) => String(r).toLowerCase() === 'superadmin')) return true;
  const ids = new Set(['GM', ...String(env?.WOO_STOCK_LOG_VIEWERS ?? '').split(',')].map((s) => s.trim().toUpperCase()).filter(Boolean));
  return ids.has(String(auth.id ?? '').trim().toUpperCase());
}

export function skipSalespeople(env = process.env) {
  const raw = env?.WOO_SKIP_SALESPERSON ?? 'WB';
  return new Set(String(raw).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
}

// Owner decision, 17 Nov 2026 reconciliation: never push stock for these. Third-party
// (Masterkraft supplier) stock, per-kg items, consignment items and non-products. Any SKU
// containing "PKG" (packages) is skipped by rule.
export const DEFAULT_SKIP_SKUS = [
  // Masterkraft brand-new / supplier stock
  'MSK-FA3452', '3459', '3458', '2070', 'MEFRKB01', 'MSK-ADJBN', '2068', 'MKF-MEFROP01',
  'MSK-FA3457', 'MSK-RK8293', 'MMSLSD01', 'MSLBPL18', 'MSWBB03', 'MK-KB01', 'MSK-BP01',
  // per-kg
  'FW-93', '5812', 'GEN-DB', 'GEN-WP',
  // consignment
  '3504', 'INB-BS01',
  // not products
  'NDIS', 'OTHER',
];

export function isSkippedSku(sku, env = process.env) {
  const s = String(sku ?? '').trim().toUpperCase();
  if (!s) return false;
  if (s.includes('PKG') || s.startsWith('TEST-')) return true;
  const extra = String(env?.WOO_SKIP_SKUS ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  return DEFAULT_SKIP_SKUS.includes(s) || extra.includes(s);
}

/**
 * The decision table. Pure — no I/O.
 * @returns {{action:'decrease'|'soldout'|'soldout_only'|'none'|'needs_human', before?:number, after?:number, check?:boolean, reason?:string}}
 */
export function planWebsiteChange({ salesperson, qty, sku, website, env = process.env }) {
  const code = sku ?? website?.sku;
  if (isSkippedSku(code, env)) return { action: 'needs_human', reason: 'On the do-not-sync list (supplier, per-kg, consignment or package) — check by hand' };
  if (!website) return { action: 'needs_human', reason: 'SKU not on the website' };
  if (website.manage_stock === false || website.stock_quantity == null) {
    return { action: 'needs_human', reason: "The website doesn't track stock for this product" };
  }
  const before = Number(website.stock_quantity);
  const n = Number(qty);
  if (!Number.isFinite(before) || !Number.isFinite(n) || n <= 0) return { action: 'needs_human', reason: 'Quantity could not be read' };

  if (skipSalespeople(env).has(String(salesperson ?? '').trim().toUpperCase())) {
    return before <= 0 ? { action: 'soldout_only', before, after: 0 } : { action: 'none', before, after: before };
  }
  const raw = before - n;
  if (raw >= 1) return { action: 'decrease', before, after: raw };
  if (raw === 0) return { action: 'soldout', before, after: 0 };
  return { action: 'soldout', before, after: 0, check: true, reason: `Website showed ${before} but ${n} sold — check by hand` };
}

/** UTC as WooCommerce's "YYYY-MM-DDTHH:mm:ss" — sent as date_created_gmt, so the site's own
 *  timezone setting can never shift the date. (Verify on staging that the publish date moves.) */
function gmtStamp(d) {
  return d.toISOString().slice(0, 19);
}

/** The REST body for a plan. Stock + sold-out fields only — nothing else is ever sent. */
export function buildWooUpdate(plan, now = new Date()) {
  if (plan.action === 'decrease') return { stock_quantity: plan.after };
  if (plan.action === 'soldout' || plan.action === 'soldout_only') {
    const back = new Date(now.getTime());
    back.setUTCFullYear(back.getUTCFullYear() - 1);
    return {
      stock_quantity: 0,
      date_created_gmt: gmtStamp(back),
      meta_data: [
        { key: 'add_to_cart_button', value: '0' },
        { key: 'enquire_button', value: '0' },
        { key: 'sold', value: '1' },
      ],
    };
  }
  return null;
}

async function outboxReady(client) {
  const r = await client.query(`SELECT to_regclass('public.woo_stock_outbox') AS t`);
  return Boolean(r.rows?.[0]?.t);
}

/**
 * INSIDE the workorder transaction: one outbox row per non-custom item.
 * Writes nothing while the feature is off or before migration 0014 is applied.
 */
export async function queueWooStock(client, { workorderId, items }, { env = process.env } = {}) {
  if (!isWooStockSyncEnabled(env)) return 0;
  const rows = (Array.isArray(items) ? items : []).filter((it) => it && !it.is_custom && it.product_id && Number(it.quantity) > 0);
  if (!rows.length) return 0;
  if (!(await outboxReady(client))) return 0;
  for (const it of rows) {
    await client.query(`INSERT INTO woo_stock_outbox (workorder_id, sku, qty) VALUES ($1, $2, $3)`, [workorderId, it.product_id, Number(it.quantity)]);
  }
  return rows.length;
}

function resolveWoo(env) {
  if (truthy(env?.WOO_MOCK)) return createMockWoo([]);
  if (wooConfigured(env)) return createWooClient({ env });
  return null;
}

const SOLD_NOTE = 'sold out: hidden from sale, Sold ticked, publish date backdated 1 year';

function describe(sku, plan, { dry }) {
  const arrow = `${sku} ${plan.before} → ${plan.after}`;
  const sold = plan.action === 'soldout' || plan.action === 'soldout_only';
  if (dry) return `Website stock (dry run): would set ${arrow} (sold-out: ${sold ? 'yes' : 'no'})`;
  if (plan.action === 'none') return `Website stock: ${sku} is a website sale — checkout already took the stock (${plan.before} left)`;
  if (plan.action === 'soldout_only') return `Website stock updated automatically: ${sku} already 0 (${SOLD_NOTE})`;
  return `Website stock updated automatically: ${arrow}${sold ? ` (${SOLD_NOTE})` : ''}`;
}

// The whole after-commit sync must not hold the workorder save open: anything not reached
// inside this budget stays 'pending' for the retry (button / daily job).
const DEFAULT_BUDGET_MS = 7000;

// An error from the website AFTER the update request went out: the change may or may not
// have been applied, so it is never retried automatically (that could take the stock twice).
// Only a clear refusal (HTTP 4xx) is safe to retry.
function isDefiniteRefusal(err) {
  const st = Number(err?.status) || Number((String(err?.message || '').match(/Website returned (\d{3})/) || [])[1]);
  return st >= 400 && st < 500;
}

/**
 * AFTER the commit. Best-effort: never throws. Safe to call again (the daily retry and the
 * "Retry website update" button call it) — it only picks up pending / failed rows.
 */
export async function syncWorkorderWebsiteStock(client, workorderId, { woo, env = process.env, now = new Date(), budgetMs = DEFAULT_BUDGET_MS } = {}) {
  const deadline = Date.now() + budgetMs;
  const summary = { skipped: false, sent: 0, dryRun: 0, failed: 0, needsHuman: 0, ticked: false };
  if (!isWooStockSyncEnabled(env)) return { ...summary, skipped: true };
  const dry = isWooStockDryRun(env);

  const log = async (notes) => {
    try {
      await client.query(
        `INSERT INTO workorder_logs (workorder_id, event_type, user_id, notes_log) VALUES ($1, $2, $3, $4)`,
        [workorderId, 'WEBSITE_STOCK_SYNC', 'WB', notes]
      );
    } catch (err) { console.error('woo stock: log failed', err?.message); }
  };
  const mark = async (row, status, result, error) => {
    await client.query(
      `UPDATE woo_stock_outbox SET status = $2::text, result = $3::jsonb, last_error = $4, attempts = attempts + 1,
              sent_at = CASE WHEN $2::text = 'sent' THEN NOW() ELSE sent_at END
        WHERE id = $1`,
      [row.id, status, JSON.stringify(result ?? null), error ?? null]
    );
    try {
      await client.query(
        `INSERT INTO integration_sync_log (source, direction, event_type, reference_id, status, payload, error)
         VALUES ('woocommerce', 'outbound', 'stock_update', $1, $2, $3::jsonb, $4)
         ON CONFLICT DO NOTHING`,
        [`outbox-${row.id}-a${Number(row.attempts || 0) + 1}`, status, JSON.stringify({ workorder_id: workorderId, sku: row.sku, ...(result || {}) }), error ?? null]
      );
    } catch (err) { console.error('woo stock: sync log failed', err?.message); }
  };

  try {
    if (!(await outboxReady(client))) return { ...summary, skipped: true };
    const wo = await client.query(`SELECT salesperson, status::text AS status FROM workorder WHERE workorder_id = $1`, [workorderId]);
    // Deleted or cancelled workorder: nothing was sold, so nothing goes to the website (the daily
    // job closes these rows; a reopen puts them back — lib/wooStockRetry.js).
    if (!wo.rows?.length || wo.rows[0].status === 'Cancelled') return { ...summary, skipped: true };
    const salesperson = wo.rows[0].salesperson;
    const { rows } = await client.query(
      `SELECT id, sku, qty, attempts FROM woo_stock_outbox WHERE workorder_id = $1 AND status IN ('pending', 'failed') ORDER BY id`,
      [workorderId]
    );
    if (!rows.length) return summary;

    // Typo guard: a single workorder never changes more than 10 website products.
    if (new Set(rows.map((r) => r.sku)).size > 10) {
      for (const row of rows) {
        // Conditional: never overwrite a row another sync has just claimed or sent.
        const g = await client.query(
          `UPDATE woo_stock_outbox SET status = 'needs_human', result = $2::jsonb, last_error = $3
            WHERE id = $1 AND status IN ('pending', 'failed')`,
          [row.id, JSON.stringify({ action: 'needs_human' }), 'More than 10 products on one workorder — check by hand']
        );
        if (g.rowCount) summary.needsHuman += 1;
      }
      await log('Website stock NOT updated: more than 10 products on one workorder — update by hand');
      return summary;
    }

    let site = woo;
    let siteError = null;
    if (!site) {
      try { site = resolveWoo(env); } catch (err) { siteError = err?.message; }
      if (!site) siteError = siteError || 'WooCommerce keys are not set up yet';
    }

    for (const row of rows) {
      if (Date.now() >= deadline) break; // left 'pending' for the retry
      // The item may have been removed from the workorder since it was queued (its portal stock
      // went back) — then nothing was sold and nothing may go to the website.
      const live = await client.query(
        `SELECT 1 FROM workorder_items WHERE workorder_id = $1 AND product_id = $2 AND status <> 'Canceled' LIMIT 1`,
        [workorderId, row.sku]
      );
      if (!live.rowCount) {
        const c = await client.query(
          `UPDATE woo_stock_outbox SET status = 'cancelled', last_error = $2 WHERE id = $1 AND status IN ('pending', 'failed')`,
          [row.id, 'Item removed from the workorder before the website was updated — nothing sent']
        );
        if (c.rowCount) await log(`Website stock for ${row.sku}: not sent — the item was removed from the workorder first`);
        continue;
      }
      // Claim the row, so a save, the Retry button and the daily job never send it twice.
      const claim = await client.query(
        `UPDATE woo_stock_outbox SET status = 'sending' WHERE id = $1 AND status IN ('pending', 'failed') RETURNING id`,
        [row.id]
      );
      if (!claim.rowCount) continue;
      let requested = false;
      try {
        if (!site) throw new Error(siteError);
        const website = await site.findProductBySku(row.sku);
        const plan = planWebsiteChange({ salesperson, qty: row.qty, sku: row.sku, website, env });
        const result = { action: plan.action, before: plan.before, after: plan.after, check: !!plan.check, product_id: website?.id ?? null };

        if (plan.action === 'needs_human') {
          await mark(row, 'needs_human', result, plan.reason);
          await log(`Website stock NOT updated for ${row.sku}: ${plan.reason} — update by hand`);
          summary.needsHuman += 1;
          continue;
        }
        if (dry) {
          await mark(row, 'dry_run', result, null);
          if (plan.action !== 'none') await log(describe(row.sku, plan, { dry: true }));
          summary.dryRun += 1;
          continue;
        }
        const body = buildWooUpdate(plan, now);
        requested = Boolean(body);
        if (body) await site.updateProduct(website.id, body);
        summary.sent += 1;
        try {
          await mark(row, 'sent', result, plan.check ? plan.reason : null);
        } catch (e) {
          // The website HAS changed. Leave the row 'sending' (never picked up again) rather
          // than 'failed', which would take the stock a second time on retry.
          console.error('woo stock: sent but bookkeeping failed', row.id, e?.message);
        }
        await log(describe(row.sku, plan, { dry: false }) + (plan.check ? ` — ${plan.reason}` : ''));
      } catch (err) {
        const msg = String(err?.message || err);
        if (requested && !isDefiniteRefusal(err)) {
          const reason = `The website didn't confirm the change (${msg}) — check the stock by hand`;
          try { await mark(row, 'needs_human', null, reason); } catch (e) { console.error('woo stock: mark failed', e?.message); }
          await log(`Website stock for ${row.sku}: ${reason}`);
          summary.needsHuman += 1;
        } else {
          try { await mark(row, 'failed', null, msg); } catch (e) { console.error('woo stock: mark failed', e?.message); }
          await log(`Website stock update failed for ${row.sku}: ${msg} — will retry`);
          summary.failed += 1;
        }
      }
    }

    if (!dry) {
      const all = await client.query(`SELECT status, result FROM woo_stock_outbox WHERE workorder_id = $1 AND status <> 'cancelled'`, [workorderId]);
      const done = all.rows.length > 0 && all.rows.every((r) => r.status === 'sent' && !(typeof r.result === 'string' ? JSON.parse(r.result) : r.result)?.check);
      if (done) {
        await client.query(`UPDATE workorder SET ecommerce = TRUE WHERE workorder_id = $1 AND ecommerce IS NOT TRUE`, [workorderId]);
        await log('Website stock updated for every item — E-Commerce flag ticked automatically');
        summary.ticked = true;
      }
    }
  } catch (err) {
    console.error('woo stock sync failed:', err?.message || err);
  }
  return summary;
}
